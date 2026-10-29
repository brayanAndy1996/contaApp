// Despachador justo (plan 008; D2, D3, D4, D5, D17, D19, D20, D21; CA-2, CA-3, CA-4, CA-9, CA-14, CA-15).
// Por cada cola con configuración: liderazgo con arriendo, round-robin de estudios, cupo global, cupo
// del estudio y lock del RUC. Cada estudio se atiende en un withTenant propio y secuencial (nunca
// anidado); la cola externa (BullMQ) y los eventos se tocan después de que el callback termina.
// Ventana de candidatos (D21): por estudio se miran hasta VENTANA_CANDIDATOS trabajos en orden y se
// despacha el primero cuyo RUC esté libre; saltar un RUC ocupado no toma locks (CA-3 intacto).
import {
  contarPendientes,
  estadoCredencial,
  revalidarEncolado,
  siguientesDisponibles,
  transicionar,
  type ConfigCola,
  type MotivoTrabajo,
  type TrabajoFila,
} from "@contapp/db";
import { randomUUID } from "node:crypto";
import {
  claveLockRuc,
  cuposVivos,
  soltarLockRuc,
  tomarCupos,
  tomarLockRuc,
} from "./arriendos.js";
import { definicionDe, rolesPermitidos } from "./catalogo.js";
import { crearClaves, type ClavesCola } from "./claves.js";
import { CacheConfig } from "./config.js";
import { payloadBullmq } from "./encolado.js";
import { publicarEvento, vistaDeFila } from "./eventos.js";
import {
  ARRIENDO_MS,
  PREFIJO_POR_DEFECTO,
  registrarFallo,
  type AgregarACola,
  type ClienteRedis,
  type DbCola,
  type NombreCola,
  type Reloj,
} from "./tipos.js";

/** Candidatos que el despachador mira por estudio y cola en cada ciclo (D21). */
export const VENTANA_CANDIDATOS = 20;

export interface OpcionesDespachador {
  db: DbCola;
  redis: ClienteRedis;
  reloj: Reloj;
  prefijo?: string;
  agregarACola: AgregarACola;
}

interface Descartado {
  fila: TrabajoFila;
  estado: "cancelado" | "error";
  motivo: MotivoTrabajo;
}

/** Lo que pasó dentro del withTenant de un estudio. Cupos, BullMQ y eventos van después del commit. */
interface Atencion {
  /** La ventana vino vacía. */
  vacia: boolean;
  /** Con la ventana vacía: si aún quedan en_cola (p. ej. con disponible_desde futuro). */
  quedan: boolean;
  despachado: TrabajoFila | null;
  descartados: Descartado[];
  /** Candidatos que otro actor cambió antes (transición perdida): solo se quitan de la pista. */
  perdidos: TrabajoFila[];
}

export class Despachador {
  private readonly db: DbCola;
  private readonly redis: ClienteRedis;
  private readonly reloj: Reloj;
  private readonly prefijo: string;
  private readonly k: ClavesCola;
  private readonly agregarACola: AgregarACola;
  private readonly config: CacheConfig;
  /** Identidad de este despachador para el liderazgo. */
  private readonly id = randomUUID();
  /** Último estudio atendido por cola (round-robin). */
  private readonly ultimo = new Map<NombreCola, string>();

  constructor(o: OpcionesDespachador) {
    this.db = o.db;
    this.redis = o.redis;
    this.reloj = o.reloj;
    this.prefijo = o.prefijo ?? PREFIJO_POR_DEFECTO;
    this.k = crearClaves(this.prefijo);
    this.agregarACola = o.agregarACola;
    this.config = new CacheConfig(o.db, o.reloj);
  }

  /** Una pasada por todas las colas configuradas. Nunca lanza: los fallos se registran sin datos. */
  async ciclo(): Promise<void> {
    const config = await this.config.obtener();
    for (const [cola, cfg] of config) {
      try {
        if (await this.liderar(cola)) await this.despacharCola(cola, cfg);
      } catch {
        registrarFallo("despachador: fallo en el ciclo de una cola");
      }
    }
  }

  /** Toma (SET NX PX) o renueva el liderazgo de la cola (D4). */
  private async liderar(cola: NombreCola): Promise<boolean> {
    const clave = this.k.lider(cola);
    if (
      (await this.redis.set(clave, this.id, "PX", ARRIENDO_MS, "NX")) === "OK"
    ) {
      return true;
    }
    if ((await this.redis.get(clave)) !== this.id) return false;
    return (await this.redis.pexpire(clave, ARRIENDO_MS)) === 1;
  }

  private async despacharCola(
    cola: NombreCola,
    cfg: ConfigCola,
  ): Promise<void> {
    const tenants = (await this.redis.smembers(this.k.tenants(cola))).sort();
    if (tenants.length === 0) return;
    const ultimo = this.ultimo.get(cola);
    const orden =
      ultimo === undefined
        ? tenants
        : [
            ...tenants.filter((t) => t > ultimo),
            ...tenants.filter((t) => t <= ultimo),
          ];
    // Locks de RUC vistos ocupados (o tomados) en este ciclo y cola: cada uno se consulta una sola vez.
    const ocupados = new Set<string>();
    for (const tenantId of orden) {
      const ahora = this.reloj.ahora();
      const ms = ahora.getTime();
      if (
        (await cuposVivos(this.redis, this.k.cupoGlobal(cola), ms)) >=
        cfg.concurrenciaGlobal
      ) {
        return;
      }
      if (
        (await cuposVivos(this.redis, this.k.cupoTenant(cola, tenantId), ms)) >=
        cfg.concurrenciaTenant
      ) {
        continue;
      }
      if (await this.atenderEstudio(cola, tenantId, ahora, ocupados)) {
        this.ultimo.set(cola, tenantId);
      }
    }
  }

  /**
   * Recorre la ventana del estudio y despacha como máximo un trabajo. true solo si despachó: el puntero
   * del round-robin lo mueve únicamente un estudio que despacha; con la ventana agotada (todos los RUC
   * ocupados o todos cancelados) el ciclo sigue con el siguiente sin moverlo (D21 (5), Ratificaciones de
   * T5/T6 (7)).
   */
  private async atenderEstudio(
    cola: NombreCola,
    tenantId: string,
    ahora: Date,
    ocupados: Set<string>,
  ): Promise<boolean> {
    // Lock del RUC tomado dentro del callback (se suelta si la transacción falla o se pierde).
    const tomado: { fila: TrabajoFila | null } = { fila: null };
    let a: Atencion;
    try {
      a = await this.db.withTenant({ tenantId }, async (tx) => {
        const r: Atencion = {
          vacia: false,
          quedan: false,
          despachado: null,
          descartados: [],
          perdidos: [],
        };
        const ventana = await siguientesDisponibles(
          tx,
          cola,
          ahora,
          VENTANA_CANDIDATOS,
        );
        if (ventana.length === 0) {
          r.vacia = true;
          r.quedan = (await contarPendientes(tx, cola)) > 0;
          return r;
        }
        const descartar = async (
          fila: TrabajoFila,
          estado: "cancelado" | "error",
          motivo: MotivoTrabajo,
        ): Promise<void> => {
          if (await transicionar(tx, fila.id, "en_cola", estado, { motivo })) {
            r.descartados.push({ fila, estado, motivo });
          } else {
            r.perdidos.push(fila);
          }
        };

        for (const fila of ventana) {
          // (2) RUC ocupado: se salta sin revalidar ni tocar el trabajo.
          const clave = claveLockRuc(this.k, fila);
          if (clave !== null) {
            if (ocupados.has(clave)) continue;
            if ((await this.redis.exists(clave)) > 0) {
              ocupados.add(clave);
              continue;
            }
          }
          // (3) RUC libre: tipo, acceso (D17) y credencial (CA-9); una cancelación no gasta el despacho.
          let def;
          try {
            def = definicionDe(fila.tipo);
          } catch {
            await descartar(fila, "error", "error_interno");
            continue;
          }
          const acceso = await revalidarEncolado(tx, {
            id: fila.id,
            clienteId: fila.clienteId,
            creadoPor: fila.creadoPor,
            rolesPermitidos: rolesPermitidos(def.permiso),
          });
          if (acceso !== "ok") {
            await descartar(fila, "cancelado", "acceso_retirado");
            continue;
          }
          if (
            def.credencial !== null &&
            (await estadoCredencial(tx, fila.clienteId, def.credencial)) ===
              "invalida"
          ) {
            await descartar(fila, "cancelado", "credencial_invalida");
            continue;
          }
          if (!(await tomarLockRuc(this.redis, this.k, fila))) {
            if (clave !== null) ocupados.add(clave); // lo ganó otro entre EXISTS y SET NX
            continue;
          }
          tomado.fila = fila;
          if (!(await transicionar(tx, fila.id, "en_cola", "ejecutando"))) {
            tomado.fila = null;
            await this.soltar(fila);
            r.perdidos.push(fila);
            continue;
          }
          if (clave !== null) ocupados.add(clave);
          r.despachado = fila;
          return r; // (4) uno por estudio y cola en cada ciclo
        }
        return r;
      });
    } catch {
      registrarFallo("despachador: fallo al atender un estudio");
      if (tomado.fila !== null) await this.soltar(tomado.fila);
      return false;
    }
    return this.despuesDelCommit(cola, tenantId, ahora, a);
  }

  private async despuesDelCommit(
    cola: NombreCola,
    tenantId: string,
    ahora: Date,
    a: Atencion,
  ): Promise<boolean> {
    const pend = this.k.pend(cola, tenantId);
    if (a.vacia) {
      if (!a.quedan) {
        await this.redis.srem(this.k.tenants(cola), tenantId);
        await this.redis.del(pend);
      }
      return false;
    }
    for (const f of a.perdidos) await this.redis.zrem(pend, f.id);
    for (const d of a.descartados) {
      await this.redis.zrem(pend, d.fila.id);
      await publicarEvento(
        this.redis,
        tenantId,
        vistaDeFila(d.fila, {
          estado: d.estado,
          motivo: d.motivo,
          terminadoEn: ahora,
        }),
        { prefijo: this.prefijo },
      );
    }
    const f = a.despachado;
    if (f === null) return false; // ventana agotada: el puntero no se mueve (D21 (5))
    await tomarCupos(this.redis, this.k, f, ahora.getTime());
    await this.redis.zrem(pend, f.id);
    try {
      await this.agregarACola(cola, payloadBullmq(f));
    } catch {
      // Queda `ejecutando` con arriendo: al vencer, el reconciliador lo resuelve (CA-10).
      registrarFallo("despachador: no se pudo agregar a la cola externa");
    }
    await publicarEvento(
      this.redis,
      tenantId,
      vistaDeFila(f, {
        estado: "ejecutando",
        motivo: null,
        iniciadoEn: ahora,
      }),
      { prefijo: this.prefijo },
    );
    return true;
  }

  private async soltar(f: TrabajoFila): Promise<void> {
    try {
      await soltarLockRuc(this.redis, this.k, f);
    } catch {
      registrarFallo("despachador: no se pudo soltar el lock (vence solo)");
    }
  }
}

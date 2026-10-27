// Despachador justo (plan 008; D2, D3, D4, D5, D17, D19, D20; CA-2, CA-3, CA-4, CA-9, CA-14, CA-15).
// Por cada cola con configuración: liderazgo con arriendo, round-robin de estudios, cupo global, cupo
// del estudio y lock del RUC. Cada estudio se atiende en un withTenant propio y secuencial (nunca
// anidado); la cola externa (BullMQ) y los eventos se tocan después de que el callback termina.
import {
  contarPendientes,
  estadoCredencial,
  revalidarEncolado,
  siguienteDisponible,
  transicionar,
  type ConfigCola,
  type MotivoTrabajo,
  type TrabajoFila,
} from "@contapp/db";
import { randomUUID } from "node:crypto";
import {
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

export interface OpcionesDespachador {
  db: DbCola;
  redis: ClienteRedis;
  reloj: Reloj;
  prefijo?: string;
  agregarACola: AgregarACola;
}

type Resultado =
  | { tipo: "vacio"; quedan: boolean }
  | { tipo: "bloqueado" }
  | { tipo: "perdido"; fila: TrabajoFila }
  | { tipo: "despachado"; fila: TrabajoFila }
  | {
      tipo: "descartado";
      fila: TrabajoFila;
      estado: "cancelado" | "error";
      motivo: MotivoTrabajo;
    };

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
      if (await this.atenderEstudio(cola, tenantId, ahora)) {
        this.ultimo.set(cola, tenantId);
      }
    }
  }

  /** Intenta despachar el siguiente trabajo del estudio. true si lo despachó. */
  private async atenderEstudio(
    cola: NombreCola,
    tenantId: string,
    ahora: Date,
  ): Promise<boolean> {
    // Lock del RUC tomado dentro del callback (se suelta si la transacción falla o se pierde).
    const tomado: { fila: TrabajoFila | null } = { fila: null };
    let r: Resultado;
    try {
      r = await this.db.withTenant(
        { tenantId },
        async (tx): Promise<Resultado> => {
          const fila = await siguienteDisponible(tx, cola, ahora);
          if (fila === null) {
            return {
              tipo: "vacio",
              quedan: (await contarPendientes(tx, cola)) > 0,
            };
          }
          const descartar = async (
            estado: "cancelado" | "error",
            motivo: MotivoTrabajo,
          ): Promise<Resultado> =>
            (await transicionar(tx, fila.id, "en_cola", estado, { motivo }))
              ? { tipo: "descartado", fila, estado, motivo }
              : { tipo: "perdido", fila };

          let def;
          try {
            def = definicionDe(fila.tipo);
          } catch {
            return descartar("error", "error_interno");
          }
          const acceso = await revalidarEncolado(tx, {
            id: fila.id,
            clienteId: fila.clienteId,
            creadoPor: fila.creadoPor,
            rolesPermitidos: rolesPermitidos(def.permiso),
          });
          if (acceso !== "ok") return descartar("cancelado", "acceso_retirado");
          if (
            def.credencial !== null &&
            (await estadoCredencial(tx, fila.clienteId, def.credencial)) ===
              "invalida"
          ) {
            return descartar("cancelado", "credencial_invalida");
          }
          if (!(await tomarLockRuc(this.redis, this.k, fila)))
            return { tipo: "bloqueado" };
          tomado.fila = fila;
          if (!(await transicionar(tx, fila.id, "en_cola", "ejecutando"))) {
            return { tipo: "perdido", fila };
          }
          return { tipo: "despachado", fila };
        },
      );
    } catch {
      registrarFallo("despachador: fallo al atender un estudio");
      if (tomado.fila !== null) await this.soltar(tomado.fila);
      return false;
    }
    return this.despuesDelCommit(cola, tenantId, ahora, r, tomado.fila);
  }

  private async despuesDelCommit(
    cola: NombreCola,
    tenantId: string,
    ahora: Date,
    r: Resultado,
    lock: TrabajoFila | null,
  ): Promise<boolean> {
    switch (r.tipo) {
      case "vacio":
        if (!r.quedan) {
          await this.redis.srem(this.k.tenants(cola), tenantId);
          await this.redis.del(this.k.pend(cola, tenantId));
        }
        return false;
      case "bloqueado":
        return false;
      case "perdido":
        if (lock !== null) await this.soltar(lock);
        await this.redis.zrem(this.k.pend(cola, tenantId), r.fila.id);
        return false;
      case "descartado":
        await this.redis.zrem(this.k.pend(cola, tenantId), r.fila.id);
        await publicarEvento(
          this.redis,
          tenantId,
          vistaDeFila(r.fila, {
            estado: r.estado,
            motivo: r.motivo,
            terminadoEn: ahora,
          }),
          { prefijo: this.prefijo },
        );
        return false;
      case "despachado": {
        const f = r.fila;
        await tomarCupos(this.redis, this.k, f, ahora.getTime());
        await this.redis.zrem(this.k.pend(cola, tenantId), f.id);
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
    }
  }

  private async soltar(f: TrabajoFila): Promise<void> {
    try {
      await soltarLockRuc(this.redis, this.k, f);
    } catch {
      registrarFallo("despachador: no se pudo soltar el lock (vence solo)");
    }
  }
}

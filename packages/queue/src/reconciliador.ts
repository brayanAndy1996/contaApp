// Reconciliador (D1, D3, D18, CA-1, CA-10): Redis se puede perder; la verdad está en job_registro.
//  - Repone la pista (tenants:{cola}) de los estudios con `en_cola` (p. ej. Redis caído al encolar).
//  - Resuelve los `ejecutando` cuyo arriendo venció (sin `ejec:{jobId}` ni cupo vivo): idempotente con
//    reintentos disponibles -> `en_cola` con el intento consumido; si no -> `error`/`interrumpido`.
// Enumera estudios con `sistema.estudios_con_trabajos` (withSistema) y atiende cada uno en un
// withTenant propio y secuencial; Redis y eventos se tocan después de cada callback.
import {
  contarPendientes,
  estudiosConTrabajos,
  leerTrabajo,
  listarTrabajos,
  transicionar,
  type ConfigCola,
  type TrabajoFila,
} from "@contapp/db";
import { liberarArriendos } from "./arriendos.js";
import { definicionDe } from "./catalogo.js";
import { crearClaves, type ClavesCola } from "./claves.js";
import { CacheConfig } from "./config.js";
import { publicarEvento, vistaDeFila } from "./eventos.js";
import {
  ARRIENDO_MS,
  PREFIJO_POR_DEFECTO,
  registrarFallo,
  type ClienteRedis,
  type DbCola,
  type NombreCola,
  type Reloj,
} from "./tipos.js";

export interface OpcionesReconciliador {
  db: DbCola;
  redis: ClienteRedis;
  reloj: Reloj;
  prefijo?: string;
  /** Antigüedad mínima (s) sin cambios para considerar un estudio (por defecto 30). */
  antiguedadSeg?: number;
}

export interface ResumenReconciliacion {
  estudios: number;
  repuestos: number;
  reencolados: number;
  interrumpidos: number;
}

interface Recuperado {
  fila: TrabajoFila;
  hacia: "en_cola" | "error";
  intentos: number;
}

export class Reconciliador {
  private readonly db: DbCola;
  private readonly redis: ClienteRedis;
  private readonly reloj: Reloj;
  private readonly prefijo: string;
  private readonly k: ClavesCola;
  private readonly antiguedadSeg: number;
  private readonly config: CacheConfig;

  constructor(o: OpcionesReconciliador) {
    this.db = o.db;
    this.redis = o.redis;
    this.reloj = o.reloj;
    this.prefijo = o.prefijo ?? PREFIJO_POR_DEFECTO;
    this.k = crearClaves(this.prefijo);
    this.antiguedadSeg = o.antiguedadSeg ?? ARRIENDO_MS / 1000;
    this.config = new CacheConfig(o.db, o.reloj);
  }

  /** Una pasada por los estudios con trabajos vivos. Nunca lanza. */
  async ciclo(): Promise<ResumenReconciliacion> {
    const resumen: ResumenReconciliacion = {
      estudios: 0,
      repuestos: 0,
      reencolados: 0,
      interrumpidos: 0,
    };
    let estudios: string[];
    try {
      estudios = await this.db.withSistema((tx) =>
        estudiosConTrabajos(tx, ["en_cola", "ejecutando"], this.antiguedadSeg),
      );
    } catch {
      registrarFallo("reconciliador: no se pudieron enumerar los estudios");
      return resumen;
    }
    const config = await this.config.obtener();
    for (const tenantId of estudios) {
      resumen.estudios++;
      try {
        await this.atenderEstudio(tenantId, config, resumen);
      } catch {
        registrarFallo("reconciliador: fallo al atender un estudio");
      }
    }
    return resumen;
  }

  private async atenderEstudio(
    tenantId: string,
    config: ReadonlyMap<NombreCola, ConfigCola>,
    resumen: ResumenReconciliacion,
  ): Promise<void> {
    const ahora = this.reloj.ahora();
    const { colas, recuperados } = await this.db.withTenant(
      { tenantId },
      async (tx) => {
        const colas: NombreCola[] = [];
        for (const cola of config.keys()) {
          if ((await contarPendientes(tx, cola)) > 0) colas.push(cola);
        }
        const recuperados: Recuperado[] = [];
        const vivos = await listarTrabajos(
          tx,
          { tipo: "global" },
          { estado: "ejecutando" },
        );
        for (const v of vivos) {
          const fila = await leerTrabajo(tx, v.id);
          if (fila === null || fila.estado !== "ejecutando") continue;
          if (!(await this.arriendoVencido(fila, ahora.getTime()))) continue;
          const reintentos = config.get(fila.cola)?.reintentos ?? 0;
          let idempotente = false;
          try {
            idempotente = definicionDe(fila.tipo).idempotente;
          } catch {
            idempotente = false;
          }
          if (idempotente && fila.intentos < reintentos) {
            const intentos = fila.intentos + 1;
            if (
              await transicionar(tx, fila.id, "ejecutando", "en_cola", {
                intentos,
              })
            ) {
              recuperados.push({ fila, hacia: "en_cola", intentos });
            }
          } else if (
            await transicionar(tx, fila.id, "ejecutando", "error", {
              motivo: "interrumpido",
            })
          ) {
            recuperados.push({ fila, hacia: "error", intentos: fila.intentos });
          }
        }
        return { colas, recuperados };
      },
    );

    const conPendientes = new Set<string>(colas);
    for (const r of recuperados) {
      await liberarArriendos(
        this.redis,
        this.k,
        r.fila,
        config.get(r.fila.cola)?.esperaRucMs ?? 0,
      );
      if (r.hacia === "en_cola") {
        conPendientes.add(r.fila.cola);
        resumen.reencolados++;
      } else {
        resumen.interrumpidos++;
      }
      await publicarEvento(
        this.redis,
        tenantId,
        vistaDeFila(
          r.fila,
          r.hacia === "en_cola"
            ? { estado: "en_cola", motivo: null, intentos: r.intentos }
            : { estado: "error", motivo: "interrumpido", terminadoEn: ahora },
        ),
        { prefijo: this.prefijo },
      );
    }
    for (const cola of conPendientes) {
      await this.redis.sadd(this.k.tenants(cola), tenantId);
      resumen.repuestos++;
    }
  }

  /** Vencido: sin arriendo del ejecutor y sin cupo vivo (el despachador da 30 s hasta que arranca). */
  private async arriendoVencido(
    f: TrabajoFila,
    ahoraMs: number,
  ): Promise<boolean> {
    if ((await this.redis.exists(this.k.ejec(f.id))) > 0) return false;
    const cupo = await this.redis.zscore(this.k.cupoGlobal(f.cola), f.id);
    return cupo === null || Number(cupo) <= ahoraMs;
  }
}

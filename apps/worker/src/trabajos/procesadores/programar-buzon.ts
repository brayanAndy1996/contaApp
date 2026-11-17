// STUB (spec 023, T5, rojo): la implementación es T12. Contrato fijado por `programar-buzon.int.spec.ts` y `test/buzon.ts`.
import type { ContappDb } from "@contapp/db";
import type { Redis } from "ioredis";
import type { LoggerTrabajos } from "../registro.js";

export interface DepsProgramarBuzon {
  /** Rol contapp_worker: `withSistema` (funciones `sistema.*`) y `withTenant` (candidatos y encolado). */
  db: Pick<ContappDb, "withSistema" | "withTenant">;
  redis: Redis;
  prefijo?: string;
  logger?: LoggerTrabajos;
  /** Dueño del candado de ese proceso; por omisión un uuid aleatorio por instancia. */
  dueno?: string;
}

export interface ResultadoCicloBuzon {
  /** `false`: otro tiene el ciclo o aún no toca el intervalo (sin efectos). */
  tomado: boolean;
  estudios: number;
  encolados: number;
  /** `buzon_ciclo_renovar` devolvió `false`: se detuvo sin encolar más. */
  perdioCandado: boolean;
}

/** Una instancia del programador: la función devuelta es un tick (toma el ciclo, encola y lo suelta). */
export function programarBuzon(
  _deps: DepsProgramarBuzon,
): () => Promise<ResultadoCicloBuzon> {
  void _deps;
  throw new Error("no implementado: programarBuzon");
}

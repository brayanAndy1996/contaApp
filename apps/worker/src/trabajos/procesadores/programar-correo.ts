// STUB (spec 028, T5 rojo): lo reemplaza T11. Ciclo `correo.programar` (R-5, R-14): contrato en `apps/worker/test/correo.ts`.
import type { ContappDb } from "@contapp/db";
import type { RedisEncolado } from "../encolar-xml.js";
import type { LoggerTrabajos } from "../registro.js";

export interface DepsProgramarCorreo {
  db: Pick<ContappDb, "withSistema" | "withTenant">;
  redis?: RedisEncolado;
  prefijo?: string;
  logger?: LoggerTrabajos;
  /** Dueño del candado: por omisión, un uuid aleatorio de esta instancia (proceso). */
  dueno?: string;
  /** Tope de envíos que `encolarAvisosCorreo` pasa a la cola por estudio y ciclo (1000). */
  lote?: number;
}

export interface ResultadoCicloCorreo {
  /** `false`: otro tiene el ciclo o aún no toca (sin efectos). */
  tomado: boolean;
  /** Estudios atendidos sin fallo. */
  estudios: number;
  avisosEncolados: number;
  resumenesCreados: number;
  /** AAAA-MM-DD de Lima del resumen que tocaba crear en este ciclo; null si no tocaba. */
  resumenDia: string | null;
  /** Se cerró el día del resumen (todos los estudios atendidos sin fallo y sin perder el candado). */
  diaCerrado: boolean;
  perdioCandado: boolean;
}

export function programarCorreo(
  d: DepsProgramarCorreo,
): () => Promise<ResultadoCicloCorreo> {
  void d;
  throw new Error("no implementado: programarCorreo");
}

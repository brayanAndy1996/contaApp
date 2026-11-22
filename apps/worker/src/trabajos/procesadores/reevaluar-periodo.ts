/* eslint-disable @typescript-eslint/no-unused-vars */
// Stub de T5 (rojo): `compras.reevaluar` (spec 027, R-12). Lo implementa T11.
import type { ContappDb } from "@contapp/db";
import type { Procesador } from "../ejecutor.js";
import type { LoggerTrabajos } from "../registro.js";

export interface DepsReevaluarPeriodo {
  db: Pick<ContappDb, "withTenant">;
  logger?: LoggerTrabajos;
}

/** Devuelve `{ revisadas, cambiadas, detenido }` (solo conteos). */
export function reevaluarPeriodo(_d: DepsReevaluarPeriodo): Procesador {
  return async () => {
    throw new Error("spec 027 no implementada: compras.reevaluar (T11)");
  };
}

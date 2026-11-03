/* eslint-disable @typescript-eslint/no-unused-vars -- stub: T7 usa los parámetros */
import { HttpException, HttpStatus } from "@nestjs/common";
import type { Tx } from "@contapp/db";

// STUB de T2 (006, pruebas primero): T7 implementa el puerto, el error y el adaptador (D4).
export interface CupoRucs {
  libres(tx: Tx, tenantId: string): Promise<number>;
  reservar(tx: Tx, tenantId: string, n: number): Promise<void>;
}

export const CUPO_RUCS = Symbol("PLANES_CUPO_RUCS");

/** Sin cupo de RUCs: 409 `{ codigo: "cupo_rucs" }` (T7 corrige el stub). */
export class CupoRucsError extends HttpException {
  constructor() {
    super({}, HttpStatus.INTERNAL_SERVER_ERROR);
  }
}

export class CupoRucsPlanes implements CupoRucs {
  async libres(_tx: Tx, _tenantId: string): Promise<number> {
    throw new Error("no implementado (006 T7)");
  }
  async reservar(_tx: Tx, _tenantId: string, _n: number): Promise<void> {
    throw new Error("no implementado (006 T7)");
  }
}

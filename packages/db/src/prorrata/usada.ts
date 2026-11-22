/* eslint-disable @typescript-eslint/no-unused-vars */
// Stub de T4 (rojo): prorrata usada ingresada por el contador, versionada (spec 026, R-8, U-9). Lo implementa T10.
import type { TxConsulta } from "../compras/errores";
import { NO_IMPLEMENTADO } from "./errores";

export interface UsadaFila {
  periodo: string;
  version: number;
  /** «NN.NN» o `null` (la ingresada se dejó sin valor). */
  porcentaje: string | null;
  autor: { id: string; nombre: string };
  creadoEn: Date;
}

export async function leerUsada(
  _tx: TxConsulta,
  _clienteId: string,
  _periodo: string,
): Promise<UsadaFila | null> {
  throw new Error(NO_IMPLEMENTADO);
}

export async function guardarUsada(
  _tx: TxConsulta,
  _e: {
    clienteId: string;
    periodo: string;
    porcentaje: string | null;
    version: number;
  },
): Promise<number> {
  throw new Error(NO_IMPLEMENTADO);
}

/* eslint-disable @typescript-eslint/no-unused-vars */
// Stub de T4 (rojo): totales de ventas por periodo para la prorrata (spec 026, R-2, R-5, R-7, CA-11). Lo implementa T10.
import type { TxConsulta } from "../compras/errores";
import { NO_IMPLEMENTADO } from "./errores";

export interface FilaUsdProrrata {
  baseGravada: string;
  igv: string;
  exonerada: string;
  inafecta: string;
  /** «3.750» o `null` si la fila USD no trae tipo de cambio. */
  tipoCambio: string | null;
}

export interface TotalesVentasPeriodo {
  periodo: string;
  cargado: boolean;
  pen: {
    baseGravada: string;
    igv: string;
    exonerada: string;
    inafecta: string;
  };
  usd: FilaUsdProrrata[];
}

export async function leerTotalesVentasProrrata(
  _tx: TxConsulta,
  _clienteId: string,
  _periodos: string[],
): Promise<TotalesVentasPeriodo[]> {
  throw new Error(NO_IMPLEMENTADO);
}

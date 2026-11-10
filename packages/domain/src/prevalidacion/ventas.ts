/* eslint-disable @typescript-eslint/no-unused-vars -- stub de T1: T7 usa los parámetros */
// Stub de T1 (spec 012b, rojo): errores de una sola fila de ventas. T7 lo implementa con la misma lógica que `prevalidar`.
import type { CabeceraTxt } from "../formatos/tipos";
import type { ErrorPrevalidacion, FilaReemplazoVenta } from "./tipos";

/** Errores de prevalidación de la propia fila (sin DUPLICADO, SIN_FILAS ni los de la cabecera). Plan 012b, Contratos: Dominio. */
export function erroresDeFilaVenta(_cabecera: CabeceraTxt, _fila: FilaReemplazoVenta): ErrorPrevalidacion[] {
  throw new Error("no implementado");
}

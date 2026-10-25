/* eslint-disable @typescript-eslint/no-unused-vars */
// STUB (T5, rojo)
export interface OpcionesKekGenerar {
  salida: string;
}
export interface DepsKekGenerar {
  log?: (linea: string) => void;
}
export interface ResultadoKekGenerar {
  rutaPublica: string;
  rutaPrivada: string;
  huella: string;
}
export function generarKek(
  _opts: OpcionesKekGenerar,
  _deps?: DepsKekGenerar,
): Promise<ResultadoKekGenerar> {
  throw new Error("no implementado");
}
export function main(_argv: string[]): Promise<void> {
  throw new Error("no implementado");
}

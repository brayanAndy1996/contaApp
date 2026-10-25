/* eslint-disable @typescript-eslint/no-unused-vars */
// STUB (T5, rojo)
export interface KeyWrapper {
  readonly kekId: string;
  wrap(dek: Buffer): Promise<Buffer>;
  verificar(): Promise<void>;
}
export interface OpcionesProveedor {
  plazoMs?: number;
  leerArchivo?: (ruta: string) => Buffer | Promise<Buffer>;
}
export function crearKeyWrapper(
  _env: Record<string, string | undefined>,
  _o?: OpcionesProveedor,
): KeyWrapper {
  throw new Error("no implementado");
}

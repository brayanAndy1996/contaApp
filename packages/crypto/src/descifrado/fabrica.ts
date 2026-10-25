/* eslint-disable @typescript-eslint/no-unused-vars */
// STUB (T5, rojo)
import type { KeyWrapper, OpcionesProveedor } from "../cifrado/fabrica";
export interface KeyUnwrapper {
  readonly kekId: string;
  unwrap(dekEnvuelta: Buffer, kekId: string): Promise<Buffer>;
  verificar(): Promise<void>;
}
export function crearKeyUnwrapper(
  _env: Record<string, string | undefined>,
  _o?: OpcionesProveedor,
): KeyUnwrapper & KeyWrapper {
  throw new Error("no implementado");
}
export function crearKeyUnwrapperAnterior(_o: {
  kekId: string;
  rutaPrivada: string;
}): KeyUnwrapper {
  throw new Error("no implementado");
}

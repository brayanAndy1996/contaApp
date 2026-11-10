import type { StorageProvider } from "./puerto.js";

// STUB (012b T3, rojo): lo implementa T9.
export function sha256Hex(datos: Uint8Array | string): string {
  void datos;
  throw new Error("no implementado");
}

export function leerVerificado(storage: StorageProvider, ruta: string, sha256: string): Promise<Uint8Array> {
  void [storage, ruta, sha256];
  return Promise.reject(new Error("no implementado"));
}

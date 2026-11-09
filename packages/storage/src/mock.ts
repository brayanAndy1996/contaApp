/* eslint-disable @typescript-eslint/no-unused-vars */
import type { StorageProvider } from "./puerto.js";

// STUB (T3, rojo): la implementación llega en T9.
export class MockStorage implements StorageProvider {
  guardar(ruta: string, bytes: Uint8Array): Promise<void> {
    return Promise.reject(new Error("no implementado"));
  }
  leer(ruta: string): Promise<Uint8Array> {
    return Promise.reject(new Error("no implementado"));
  }
  eliminar(ruta: string): Promise<void> {
    return Promise.reject(new Error("no implementado"));
  }
}

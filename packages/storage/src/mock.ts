import { ArchivoNoEncontradoError } from "./errores.js";
import type { StorageProvider } from "./puerto.js";
import { validarRuta } from "./ruta.js";

/** Almacenamiento en memoria (adaptador por defecto, `STORAGE=mock`). Guarda y devuelve copias. */
export class MockStorage implements StorageProvider {
  private readonly archivos = new Map<string, Uint8Array>();

  guardar(ruta: string, bytes: Uint8Array): Promise<void> {
    try {
      this.archivos.set(validarRuta(ruta), Uint8Array.from(bytes));
      return Promise.resolve();
    } catch (e) {
      return Promise.reject(e);
    }
  }

  leer(ruta: string): Promise<Uint8Array> {
    try {
      const guardado = this.archivos.get(validarRuta(ruta));
      if (guardado === undefined) throw new ArchivoNoEncontradoError();
      return Promise.resolve(Uint8Array.from(guardado));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  eliminar(ruta: string): Promise<void> {
    try {
      this.archivos.delete(validarRuta(ruta));
      return Promise.resolve();
    } catch (e) {
      return Promise.reject(e);
    }
  }
}

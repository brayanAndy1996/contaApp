// @contapp/storage (spec 016): puerto StorageProvider y sus implementaciones mock y local.
import type { StorageProvider } from "./puerto.js";

export type { StorageProvider } from "./puerto.js";
export {
  ArchivoNoEncontradoError,
  ConfiguracionStorageError,
  RutaStorageError,
} from "./errores.js";
export { rutaXml, validarRuta } from "./ruta.js";
export { MockStorage } from "./mock.js";
export { LocalStorage } from "./local.js";

/** Lo mínimo del log que usa la guarda (el `Logger` de Nest lo cumple). */
export interface LoggerStorage {
  warn(mensaje: string): void;
}

/* eslint-disable @typescript-eslint/no-unused-vars */
// STUB (T3, rojo): la implementación llega en T9.
export function crearStorage(
  env: Record<string, string | undefined>,
  logger?: LoggerStorage,
): StorageProvider {
  throw new Error("no implementado");
}

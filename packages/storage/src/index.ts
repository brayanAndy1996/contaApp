// @contapp/storage (spec 016): puerto StorageProvider y sus implementaciones mock y local.
import { ConfiguracionStorageError } from "./errores.js";
import { LocalStorage } from "./local.js";
import { MockStorage } from "./mock.js";
import type { StorageProvider } from "./puerto.js";

export type { StorageProvider } from "./puerto.js";
export {
  ArchivoAlteradoError,
  ArchivoNoEncontradoError,
  ConfiguracionStorageError,
  RutaStorageError,
  StorageIOError,
} from "./errores.js";
export { rutaArchivo, rutaXml, validarRuta } from "./ruta.js";
export { leerVerificado, sha256Hex } from "./hash.js";
export { MockStorage } from "./mock.js";
export { LocalStorage } from "./local.js";

/** Lo mínimo del log que usa la guarda (el `Logger` de Nest lo cumple). */
export interface LoggerStorage {
  warn(mensaje: string): void;
}

type Entorno = Record<string, string | undefined>;

/**
 * Crea el almacenamiento del entorno: `STORAGE=mock|local` (ausente = `mock`), raíz `STORAGE_DIR` (por defecto
 * `./storage`). Con `NODE_ENV=production` y `mock` falla salvo `PERMITIR_ADAPTADORES_MOCK=1` (entonces avisa).
 * Los errores nombran la variable y nunca imprimen su valor.
 */
export function crearStorage(env: Entorno, logger?: LoggerStorage): StorageProvider {
  const valor = env.STORAGE ?? "mock";
  if (valor === "local") {
    const dir = env.STORAGE_DIR;
    return new LocalStorage(dir === undefined || dir === "" ? "./storage" : dir);
  }
  if (valor !== "mock") {
    throw new ConfiguracionStorageError("Valor no soportado para STORAGE (use mock o local)", "STORAGE");
  }
  if (env.NODE_ENV === "production") {
    if (env.PERMITIR_ADAPTADORES_MOCK !== "1") {
      throw new ConfiguracionStorageError(
        "STORAGE=mock con NODE_ENV=production. Configure STORAGE=local o fije PERMITIR_ADAPTADORES_MOCK=1.",
        "STORAGE",
      );
    }
    logger?.warn("STORAGE en mock en producción (PERMITIR_ADAPTADORES_MOCK=1)");
  }
  return new MockStorage();
}

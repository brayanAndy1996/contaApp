import { createHash, timingSafeEqual } from "node:crypto";
import { ArchivoAlteradoError } from "./errores.js";
import type { StorageProvider } from "./puerto.js";
import { validarRuta } from "./ruta.js";

const RE_SHA256 = /^[0-9a-f]{64}$/;

/** SHA-256 en hex minúsculas. El texto se codifica en UTF-8. */
export function sha256Hex(datos: Uint8Array | string): string {
  return createHash("sha256").update(datos).digest("hex");
}

/**
 * Lee `ruta` y verifica su SHA-256 contra `sha256` (hex de 64, sin distinguir mayúsculas). Si no coincide, o el hash
 * esperado está mal formado, lanza `ArchivoAlteradoError` (mensaje fijo: sin ruta ni hash). Una ruta inválida lanza
 * `RutaStorageError` y un archivo ausente `ArchivoNoEncontradoError` (se propagan tal cual).
 */
export async function leerVerificado(storage: StorageProvider, ruta: string, sha256: string): Promise<Uint8Array> {
  validarRuta(ruta);
  const bytes = await storage.leer(ruta);
  const esperado = String(sha256).toLowerCase();
  if (!RE_SHA256.test(esperado)) throw new ArchivoAlteradoError();
  const real = Buffer.from(sha256Hex(bytes), "hex");
  if (!timingSafeEqual(real, Buffer.from(esperado, "hex"))) throw new ArchivoAlteradoError();
  return bytes;
}

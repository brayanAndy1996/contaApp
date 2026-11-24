/* eslint-disable @typescript-eslint/no-unused-vars -- stub en rojo de T4 (spec 028): T10 lo reemplaza */
// STUB (spec 028, T4 rojo): lo reemplaza T10. Token de baja (R-7): lo crea el worker por cada correo; la baja sin sesión
// (`aplicarBaja(hashHex)`) vive en `auth/repositorio.ts` (`AuthRepo`), como `recuperacionConsumir`.
import type { TxConsulta } from "./errores";

/** `correo_baja_token_crear(p_envio, p_hash)`: `hash` = SHA-256 (32 bytes) del token; vence a los 90 días. 22023 si no mide 32 bytes. */
export async function crearTokenBaja(
  _tx: TxConsulta,
  _envioId: string,
  _hash: Buffer,
): Promise<void> {
  throw new Error("no implementado: crearTokenBaja");
}

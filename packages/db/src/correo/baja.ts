// Token de baja (spec 028, R-7): lo crea el worker por cada correo; la baja sin sesión (`aplicarBaja(hashHex)`) vive en
// `auth/repositorio.ts` (`AuthRepo`), como `recuperacionConsumir`.
import {
  ARGUMENTO_INVALIDO,
  consultarCorreo,
  CorreoRepoError,
  exigirIdCorreo,
  type TxConsulta,
} from "./errores";

const SQL_CREAR = "select correo_baja_token_crear($1::uuid, $2::bytea)";

/** `correo_baja_token_crear(p_envio, p_hash)`: `hash` = SHA-256 (32 bytes) del token; vence a los 90 días. 22023 si no mide 32 bytes. */
export async function crearTokenBaja(
  tx: TxConsulta,
  envioId: string,
  hash: Buffer,
): Promise<void> {
  if (!Buffer.isBuffer(hash) || hash.length !== 32)
    throw new CorreoRepoError(ARGUMENTO_INVALIDO);
  const id = exigirIdCorreo(envioId);
  await consultarCorreo(tx, SQL_CREAR, [id, hash]);
}

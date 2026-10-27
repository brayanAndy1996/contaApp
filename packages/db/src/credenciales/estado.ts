// Estado de la credencial (spec 008, D13, CA-9). `marcarCredencialInvalida` la usa el worker (contapp_worker escribe
// solo las 3 columnas de estado); `estadoCredencial` la leen backend y worker sin tocar columnas del sobre.
// Reemplazar el ciphertext la devuelve a 'configurada' (trigger credencial_reinicia_estado, 0018).
import { CredencialRepoError } from "./errores";
import type { TipoCredencial, TxConsulta } from "./repositorio";

export type EstadoDeCredencial = "configurada" | "verificada" | "invalida";
export type MotivoEstadoCredencial = "credencial_invalida";

const SQL_MARCAR = `update credencial set estado = 'invalida', estado_motivo = $3, estado_at = now()
  where cliente_id = $1 and tipo = $2 and estado <> 'invalida'`;

const SQL_ESTADO =
  "select estado from credencial where cliente_id = $1 and tipo = $2";

async function consultar(
  tx: TxConsulta,
  texto: string,
  valores: unknown[],
): Promise<{
  rows: Array<{ estado?: EstadoDeCredencial }>;
  rowCount: number | null;
}> {
  try {
    return await tx.query(texto, valores);
  } catch (e) {
    throw CredencialRepoError.desde(e);
  }
}

/** true solo si la credencial existía y no estaba ya 'invalida' (el Notificador avisa una sola vez). Rol: contapp_worker. */
export async function marcarCredencialInvalida(
  tx: TxConsulta,
  clienteId: string,
  tipo: TipoCredencial,
  motivo: MotivoEstadoCredencial = "credencial_invalida",
): Promise<boolean> {
  const r = await consultar(tx, SQL_MARCAR, [clienteId, tipo, motivo]);
  return r.rowCount === 1;
}

/** Estado de la credencial (cliente, tipo) del estudio, o null si no existe. */
export async function estadoCredencial(
  tx: TxConsulta,
  clienteId: string,
  tipo: TipoCredencial,
): Promise<EstadoDeCredencial | null> {
  const r = await consultar(tx, SQL_ESTADO, [clienteId, tipo]);
  return r.rows[0]?.estado ?? null;
}

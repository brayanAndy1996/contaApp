// Estado de la credencial (spec 008, D13, CA-9). `marcarCredencialInvalida` la usa el worker (contapp_worker escribe
// solo las 3 columnas de estado); `estadoCredencial` la leen backend y worker sin tocar columnas del sobre.
// Reemplazar el ciphertext la devuelve a 'configurada' (trigger credencial_reinicia_estado, 0018).
import { CredencialRepoError } from "./errores";
import type { TipoCredencial, TxConsulta } from "./repositorio";

export type EstadoDeCredencial = "configurada" | "verificada" | "invalida";
export type MotivoEstadoCredencial = "credencial_invalida";

const SQL_MARCAR = `update credencial set estado = 'invalida', estado_motivo = $3, estado_at = clock_timestamp()
  where cliente_id = $1 and tipo = $2 and estado <> 'invalida'`;

// H-008-1b-5: solo si el estado de la credencial no cambió después de que empezó el trabajo que falló (reemplazar el
// ciphertext la reinicia con estado_at = clock_timestamp(), trigger de 0021): el fallo del intento viejo no bloquea la
// nueva.
const SQL_MARCAR_SI_SIN_CAMBIOS = `${SQL_MARCAR}
  and (estado_at is null or estado_at <= (select j.iniciado_en from job_registro j where j.id = $4))`;

// H-008-2a-4: con la versión de la fila que vio el trabajo al empezar (`versionCredencial`), solo si la fila sigue
// siendo esa. Un guardado que escribió antes del despacho pero confirmó durante el trabajo es OTRA versión (otro xmin),
// aunque su `estado_at` sea anterior al `iniciado_en`.
const SQL_MARCAR_SI_MISMA_VERSION = `${SQL_MARCAR} and xmin::text = $4`;

// Versión de la fila: el xmin (transacción que la escribió). Cambia con cada UPDATE confirmado de la fila.
const SQL_VERSION =
  "select xmin::text as version from credencial where cliente_id = $1 and tipo = $2";

const SQL_ESTADO =
  "select estado from credencial where cliente_id = $1 and tipo = $2";

async function consultar(
  tx: TxConsulta,
  texto: string,
  valores: unknown[],
): Promise<{
  rows: Array<{ estado?: EstadoDeCredencial; version?: string }>;
  rowCount: number | null;
}> {
  try {
    return await tx.query(texto, valores);
  } catch (e) {
    throw CredencialRepoError.desde(e);
  }
}

/**
 * true solo si la credencial existía y no estaba ya 'invalida' (el Notificador avisa una sola vez). Rol: contapp_worker.
 * Con `trabajoId` (el ejecutor), además solo si el estado no cambió desde el `iniciado_en` de ese trabajo: una
 * credencial reemplazada (o verificada) mientras el trabajo corría no se marca por el fallo del intento viejo.
 * Con `version` (la que dio `versionCredencial` al empezar el trabajo), solo si la fila sigue siendo esa versión
 * (H-008-2a-4); `version` null (no había credencial al empezar) no marca nada.
 */
export async function marcarCredencialInvalida(
  tx: TxConsulta,
  clienteId: string,
  tipo: TipoCredencial,
  motivo: MotivoEstadoCredencial = "credencial_invalida",
  trabajoId?: string,
  version?: string | null,
): Promise<boolean> {
  if (version === null) return false;
  const r =
    version !== undefined
      ? await consultar(tx, SQL_MARCAR_SI_MISMA_VERSION, [
          clienteId,
          tipo,
          motivo,
          version,
        ])
      : trabajoId === undefined
        ? await consultar(tx, SQL_MARCAR, [clienteId, tipo, motivo])
        : await consultar(tx, SQL_MARCAR_SI_SIN_CAMBIOS, [
            clienteId,
            tipo,
            motivo,
            trabajoId,
          ]);
  return r.rowCount === 1;
}

/**
 * Versión de la fila de la credencial (cliente, tipo) que ve la transacción, o null si no existe (H-008-2a-4). El
 * ejecutor la lee al empezar el trabajo y la pasa a `marcarCredencialInvalida`. Rol: contapp_worker (no lee el sobre).
 */
export async function versionCredencial(
  tx: TxConsulta,
  clienteId: string,
  tipo: TipoCredencial,
): Promise<string | null> {
  const r = await consultar(tx, SQL_VERSION, [clienteId, tipo]);
  return r.rows[0]?.version ?? null;
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

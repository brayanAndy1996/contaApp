// «Revisar ahora» registra la solicitud en el estado del cliente (spec 023, P-6). El backend solo tiene UPDATE de esta columna
// (0054); la fila ya existe porque `bloquearEstadoBuzon` la crea y la bloquea antes en la misma transacción de withTenant.
import { BuzonRepoError, consultar, type TxConsulta } from "./errores";

const SQL_MARCAR_SOLICITUD =
  "update buzon_estado_cliente set ultima_solicitud_en = now() where cliente_id = $1::uuid";

/** Fija `ultima_solicitud_en = now()`. Sin fila de estado falla con SQLSTATE P0002; un fallo de `pg` solo conserva el SQLSTATE. */
export async function marcarSolicitudBuzon(
  tx: TxConsulta,
  clienteId: string,
): Promise<void> {
  const r = await consultar(tx, SQL_MARCAR_SOLICITUD, [clienteId]);
  if (r.rowCount === 0) throw new BuzonRepoError("P0002");
}

const SQL_ULTIMA_TERMINADA = `select estado, motivo, terminado_en from job_registro
 where cliente_id = $1::uuid and tipo = 'sol.buzon.revisar' and terminado_en is not null
 order by terminado_en desc, id desc limit 1`;

/**
 * Instante en que terminó la última captura del cliente SI terminó por credencial inválida (`error` + `credencial_invalida`);
 * `null` si no hay capturas terminadas o la última terminó de otro modo. Una captura posterior bien terminada la reemplaza.
 */
export async function fallaPorCredencialBuzon(
  tx: TxConsulta,
  clienteId: string,
): Promise<Date | null> {
  const f = (await consultar(tx, SQL_ULTIMA_TERMINADA, [clienteId])).rows[0];
  if (f === undefined || f.estado !== "error" || f.motivo !== "credencial_invalida") return null;
  const t = f.terminado_en;
  return t instanceof Date ? t : new Date(String(t));
}

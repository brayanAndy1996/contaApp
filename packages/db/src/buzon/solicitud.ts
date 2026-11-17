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

// «Revisar ahora» registra la solicitud en el estado del cliente (spec 023, P-6). El backend solo tiene UPDATE de esta columna
// (0054); la fila ya existe porque `bloquearEstadoBuzon` la crea y la bloquea antes en la misma transacción.
import { BuzonRepoError, type Tx } from "@contapp/db";

const SQL_MARCAR_SOLICITUD = "update buzon_estado_cliente set ultima_solicitud_en = now() where cliente_id = $1::uuid";

/** Fija `ultima_solicitud_en = now()`. Un fallo de `pg` sale como `BuzonRepoError` con solo el SQLSTATE. */
export async function marcarSolicitudBuzon(tx: Pick<Tx, "query">, clienteId: string): Promise<void> {
  try {
    const r = await tx.query(SQL_MARCAR_SOLICITUD, [clienteId]);
    if ((r.rowCount ?? 0) === 0) throw new BuzonRepoError("P0002");
  } catch (e) {
    throw e instanceof BuzonRepoError ? e : BuzonRepoError.desde(e);
  }
}

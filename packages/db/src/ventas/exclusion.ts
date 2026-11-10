// Exclusión de ventas del SIRE con error (spec 012b, P-8, D12, CA-15, CA-16). `venta` es inmutable (013 D4): la exclusión vive en
// `venta_exclusion`, de solo inserción, y restaurar cierra la vigente escribiendo `restaurada_*` (el registro se conserva). Una sola
// vigente por venta (único parcial). El trigger de 0039 rechaza (23514) una venta inexistente, manual o de otro cliente o periodo;
// la regla «tiene error» la aplica el servicio con el dominio. Quien llama toma antes el advisory del libro y `venta_periodo FOR
// SHARE` (orden de bloqueo del plan). Nada de esto registra el motivo.
import { consultar, type Fila, type TxConsulta } from "./errores";
import type { DatosExcluirVenta, ExclusionVenta } from "./tipos";

const COLUMNAS = `id, venta_id, motivo, excluida_por, excluida_en`;

// ON CONFLICT sobre el único parcial de vigentes: dos exclusiones a la vez dejan una; la otra no inserta (null).
const SQL_EXCLUIR = `insert into venta_exclusion (cliente_id, periodo, venta_id, motivo, excluida_por)
  values ($1, $2, $3, $4, $5)
  on conflict (tenant_id, venta_id) where restaurada_en is null do nothing
  returning ${COLUMNAS}`;

const SQL_VIGENTE = `select ${COLUMNAS} from venta_exclusion where venta_id = $1 and restaurada_en is null`;

// Solo escribe restaurada_* (el trigger rechaza cualquier otro cambio). Dos a la vez: la segunda ya no ve la vigente.
const SQL_RESTAURAR = `update venta_exclusion set restaurada_por = $2, restaurada_en = now()
  where venta_id = $1 and restaurada_en is null`;

const aExclusion = (f: Fila): ExclusionVenta => ({
  id: f.id,
  ventaId: f.venta_id,
  motivo: f.motivo,
  excluidaPor: f.excluida_por,
  excluidaEn: f.excluida_en,
  restauradaPor: null,
  restauradaEn: null,
});

/**
 * Excluye una venta del SIRE. Devuelve la exclusión creada, o `null` si la venta ya tenía una vigente (`ya_excluida`), también con
 * dos solicitudes simultáneas. Una venta que el trigger rechaza lanza VentasRepoError con su SQLSTATE (23514).
 */
export async function excluirVenta(
  tx: TxConsulta,
  d: DatosExcluirVenta,
): Promise<ExclusionVenta | null> {
  const r = await consultar(tx, SQL_EXCLUIR, [
    d.clienteId,
    d.periodo,
    d.ventaId,
    d.motivo,
    d.usuarioId,
  ]);
  return r.rows[0] ? aExclusion(r.rows[0]) : null;
}

/** Cierra la exclusión vigente de la venta: `true` si cerró una; `false` si no había (`no_excluida`). */
export async function restaurarVenta(
  tx: TxConsulta,
  ventaId: string,
  usuarioId: string,
): Promise<boolean> {
  const r = await consultar(tx, SQL_RESTAURAR, [ventaId, usuarioId]);
  return r.rowCount > 0;
}

/** La exclusión vigente de la venta o `null`. */
export async function exclusionVigente(
  tx: TxConsulta,
  ventaId: string,
): Promise<ExclusionVenta | null> {
  const r = await consultar(tx, SQL_VIGENTE, [ventaId]);
  return r.rows[0] ? aExclusion(r.rows[0]) : null;
}

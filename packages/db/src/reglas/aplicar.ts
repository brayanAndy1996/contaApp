// Aplicación de R-HIS en la descarga (spec 021, D-6, D-7, D-8, CA-4, CA-10). Solo el worker: las funciones acotadas de 0048 y
// 0052 (por lotes, T25c) son SECURITY DEFINER con EXECUTE solo para contapp_worker. La BD recalcula la consolidación y rechaza (42501) lo que no sea
// exactamente la versión 1 consolidada en el destino de la regla; aquí solo se traducen nombres y se pasa la `tx`.
import { consultar, type TxConsulta } from "../compras/errores";
import type { MontosCompra } from "../compras/tipos";
import type { DestinoRegla, ReglaVigente } from "./tipos";

const SQL_VIGENTES = `select regla_id, doc_tipo, doc_numero, destino, version
  from public.reglas_historial_vigentes($1, $2)`;
const SQL_APLICAR = `select public.aplicar_regla_historial($1, $2, $3::jsonb) as n`;
const SQL_APLICAR_LOTE = `select public.aplicar_reglas_historial($1::jsonb) as n`;

/** Tope de `aplicar_reglas_historial` (0052): compras por llamada. */
export const LOTE_HISTORIAL = 500;

/** Una compra nueva de esta transacción con la regla que la mueve y su versión 1 consolidada en el destino. */
export interface AplicacionHistorial {
  compraId: string;
  reglaId: string;
  datos: MontosCompra;
}

/** `p_datos` de `aplicar_regla_historial`: las 11 columnas de monto en snake_case, como cadenas NUMERIC. */
export const datosHistorial = (m: MontosCompra): Record<string, string> => ({
  bi_dg: m.biDg,
  igv_dg: m.igvDg,
  bi_dgng: m.biDgng,
  igv_dgng: m.igvDgng,
  bi_dng: m.biDng,
  igv_dng: m.igvDng,
  no_gravado: m.noGravado,
  isc: m.isc,
  icbper: m.icbper,
  otros_tributos: m.otrosTributos,
  total: m.total,
});

/**
 * Reglas vivas y activas del cliente aprendidas antes de `periodo` (P-5), bloqueadas FOR SHARE hasta el fin de la transacción
 * (CA-9). Vacío si R-HIS está apagado en el estudio.
 */
export async function reglasHistorialVigentes(
  tx: TxConsulta,
  clienteId: string,
  periodo: string,
): Promise<ReglaVigente[]> {
  const r = await consultar(tx, SQL_VIGENTES, [clienteId, periodo]);
  return r.rows.map((f) => ({
    reglaId: f.regla_id as string,
    docTipo: f.doc_tipo as string,
    docNumero: f.doc_numero as string,
    destino: f.destino as DestinoRegla,
    version: f.version as number,
  }));
}

/** Crea la versión 2 `historial` de una compra nueva de esta transacción. Devuelve su `n` (2); cualquier rechazo, 42501. */
export async function aplicarReglaHistorial(
  tx: TxConsulta,
  compraId: string,
  reglaId: string,
  datos: MontosCompra,
): Promise<number> {
  const r = await consultar(tx, SQL_APLICAR, [compraId, reglaId, JSON.stringify(datosHistorial(datos))]);
  return r.rows[0]!.n as number;
}

/**
 * Crea la versión 2 `historial` de cada compra, por lotes de `LOTE_HISTORIAL` (T25c): un viaje a la BD por lote, con las mismas
 * validaciones que `aplicarReglaHistorial`. Todo o nada: una compra rechazada (42501) rechaza su lote entero y la transacción
 * queda abortada. Devuelve cuántas versiones creó.
 */
export async function aplicarReglasHistorial(tx: TxConsulta, items: readonly AplicacionHistorial[]): Promise<number> {
  let creadas = 0;
  for (let desde = 0; desde < items.length; desde += LOTE_HISTORIAL) {
    const parte = items.slice(desde, desde + LOTE_HISTORIAL);
    const r = await consultar(tx, SQL_APLICAR_LOTE, [
      JSON.stringify(parte.map((i) => ({ compra: i.compraId, regla: i.reglaId, datos: datosHistorial(i.datos) }))),
    ]);
    creadas += r.rows[0]!.n as number;
  }
  return creadas;
}

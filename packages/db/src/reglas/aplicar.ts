// Aplicación de R-HIS en la descarga (spec 021, D-6, D-7, D-8, CA-4, CA-10). Solo el worker: las dos funciones acotadas de 0048
// son SECURITY DEFINER con EXECUTE solo para contapp_worker. La BD recalcula la consolidación y rechaza (42501) lo que no sea
// exactamente la versión 1 consolidada en el destino de la regla; aquí solo se traducen nombres y se pasa la `tx`.
import { consultar, type TxConsulta } from "../compras/errores";
import type { MontosCompra } from "../compras/tipos";
import type { DestinoRegla, ReglaVigente } from "./tipos";

const SQL_VIGENTES = `select regla_id, doc_tipo, doc_numero, destino, version
  from public.reglas_historial_vigentes($1, $2)`;
const SQL_APLICAR = `select public.aplicar_regla_historial($1, $2, $3::jsonb) as n`;

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

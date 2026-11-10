// Re-evaluación de una compra cuando llega o cambia su XML (spec 016, D-5, D-7, P-2, CA-6 a CA-8). No crea versión ni mueve el
// puntero: inserta la evaluación `n + 1` de la versión vigente con sus hallazgos, así `versionBase`, deshacer y las ediciones en
// curso no cambian. Vale en cualquier estado del periodo (no cambia montos).
//
// ORDEN DE BLOQUEO (plan 016, 014 ampliado): [advisory del comprobante: lo toma `guardarDocumentoXml`, antes] -> `compra_periodo`
// FOR SHARE -> `compra` FOR UPDATE. No se toma ninguna `compra_operacion` (no hay operación) ni otro advisory después.
import {
  consultar,
  ComprasReglaError,
  type TxConsulta,
} from "../compras/errores";
import {
  esUuid,
  guardarEvaluaciones,
  leerCompra,
  xmlDeCompras,
} from "../compras/repositorio";
import type { Evaluar } from "../compras/tipos";

const SQL_PERIODO_COMPARTIDO = `select 1 from compra_periodo where cliente_id = $1 and periodo = $2 for share`;

const SQL_SIGUIENTE = `select coalesce(max(n), 0) + 1 as n from compra_evaluacion where compra_id = $1 and version_n = $2`;

export interface ResultadoReevaluar {
  /** La versión evaluada (la vigente, ya bloqueada). */
  version: number;
  /** Número de la evaluación insertada. */
  n: number;
  /** El XML con el que se evaluó, o `null`. */
  documentoXmlId: string | null;
}

/**
 * Re-evalúa la versión vigente de la compra con el XML vigente de su comprobante, leído en esta misma transacción después de
 * bloquear la fila. `no_encontrada` (ComprasReglaError) si la compra no existe, es de otro estudio o está descartada. Si
 * `evaluar` lanza, se propaga y no queda nada escrito.
 */
export async function reevaluarCompra(
  tx: TxConsulta,
  compraId: string,
  f: { evaluar: Evaluar },
): Promise<ResultadoReevaluar> {
  if (!esUuid(compraId)) throw new ComprasReglaError("no_encontrada");
  // Cliente y periodo para bloquear primero el periodo; esta lectura no bloquea.
  const previa = await leerCompra(tx, compraId, false);
  if (!previa) throw new ComprasReglaError("no_encontrada");
  await consultar(tx, SQL_PERIODO_COMPARTIDO, [
    previa.clienteId,
    previa.periodo,
  ]);
  // Relee la versión vigente ya bloqueada: si otra transacción creó una versión mientras esperábamos, se evalúa esa.
  const actual = await leerCompra(tx, compraId, true);
  if (!actual) throw new ComprasReglaError("no_encontrada");
  const xml = (await xmlDeCompras(tx, [actual])).get(actual.id) ?? null;
  const n = (await consultar(tx, SQL_SIGUIENTE, [actual.id, actual.version]))
    .rows[0]!.n as number;
  await guardarEvaluaciones(tx, [{ fila: actual, n, xml }], f.evaluar);
  return { version: actual.version, n, documentoXmlId: xml?.id ?? null };
}

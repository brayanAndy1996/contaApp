// Lectura de la lupa (spec 016, D-8, CA-18): el detalle de 014 (compra vigente, historial de versiones y hallazgos de la última
// evaluación) más el XML vigente del comprobante (su `detalle` jsonb guardado, sin re-parsear) y su estado de obtención. Se llama
// `leerDetalleXml` porque `leerDetalleCompra` ya es de 014 (`compras/lectura.ts`).
import { leerDetalleCompra, type DetalleLeido } from "../compras/lectura";
import type { TxConsulta } from "../compras/errores";
import {
  leerXmlVigente,
  normalizarIdentidadXml,
  type IdentidadXml,
  type XmlVigente,
} from "./documentos";
import { leerObtencion, type ObtencionXml } from "./obtencion";

export interface DetalleXmlLeido extends DetalleLeido {
  /** Identidad del comprobante para su XML (RUC del proveedor, tipo, serie y número normalizados). */
  identidad: IdentidadXml;
  /** El XML vigente (mayor `n`) o `null`. */
  xml: XmlVigente | null;
  /** Estado de obtención efectivo, o `null` si nadie lo pidió. */
  obtencion: ObtencionXml | null;
}

/**
 * La compra viva con lo que muestra la lupa, o `null` si no existe, es de otro cliente, periodo o estudio (RLS), está descartada
 * o el id está mal formado (el mismo `null` en todos los casos).
 */
export async function leerDetalleXml(
  tx: TxConsulta,
  clienteId: string,
  periodo: string,
  compraId: string,
): Promise<DetalleXmlLeido | null> {
  const d = await leerDetalleCompra(tx, clienteId, periodo, compraId);
  if (d === null) return null;
  const identidad = normalizarIdentidadXml({
    rucEmisor: d.compra.docNumero,
    tipo: d.compra.tipoDoc,
    serie: d.compra.serie,
    numero: d.compra.numero,
  });
  const xml = await leerXmlVigente(tx, clienteId, identidad);
  const obtencion = await leerObtencion(tx, clienteId, identidad);
  return { ...d, identidad, xml, obtencion };
}

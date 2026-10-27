// Catálogo fijo de explicaciones (plan 011, Decisiones: "Ratificación de contratos").
// Las cifras son el toString() canónico de Money, con signo. Nunca texto del XML salvo la
// palabra del diccionario (R-GP).
import type { Money } from "../dinero/index";

const t = (m: Money): string => m.toString();

// ---------------------------------------------------------------- R-ISC
export const iscSinXml = (bi: Money): string => `Base gravada ${t(bi)} con IGV 0: posible ISC`;
export const ISC_XML_EXACTO = "Base gravada con IGV 0: el XML indica ISC";
export const iscXmlSinIsc = (bi: Money): string => `Base gravada ${t(bi)} con IGV 0. XML sin ISC: revisar`;
export const iscXmlNoCabe = (bi: Money, isc: Money): string =>
  `Base gravada ${t(bi)} con IGV 0: el ISC del XML (${t(isc)}) no cabe en un solo destino: revisar`;
export const MARCA_ISC_SIN_XML = "Proveedor emisor de ISC: revisar con el XML";
export const marcaIscConXml = (isc: Money): string => `Proveedor emisor de ISC: el XML indica ISC ${t(isc)}`;

// ---------------------------------------------------------------- R-MIX (base + sufijo)
export const mix = (igv: Money, bi: Money): string => `${t(igv)} no es 18 % ni 10 % de ${t(bi)}`;
export const sufijoMixExacto = (g: Money): string => `; el XML indica gravado ${t(g)}`;
export const sufijoMixGravadoFuera = (g: Money): string =>
  `; el gravado del XML (${t(g)}) no produce ese IGV: confirma el monto`;
export const sufijoMixIgvDistinto = (igvXml: Money): string =>
  `; el IGV del XML (${t(igvXml)}) es distinto: confirma el monto`;
export const SUFIJO_MIX_RANGO_VACIO = " y no se puede separar: revisar";
/** T10: XML con varios destinos con BI ≠ 0 (su gravado e IGV no se asignan a un destino). */
export const SUFIJO_MIX_VARIOS_DESTINOS = "; el XML no separa por destino: confirma el monto";

// ---------------------------------------------------------------- R-RED, R-NEW, R-GP (T10)
export const red = (suma: Money, total: Money): string =>
  `La suma de componentes (${t(suma)}) no es igual al total (${t(total)}): diferencia ${t(total.restar(suma))}`;
/** T10: Σ o total − Σ exceden NUMERIC(14,2): no hay cifra canónica que mostrar. */
export const RED_FUERA_DE_RANGO = "La suma de componentes no es igual al total y excede el rango de montos: revisar";
export const SUFIJO_RED_XML = "; el XML indica el monto correcto";
export const redUsd = (tc: string): string =>
  `Los montos en PEN no coinciden con la conversión por componente con TC ${tc}`;
export const PROVEEDOR_NUEVO = "Proveedor nuevo: elige la clasificación";
export const gastoPersonal = (palabra: string): string => `Posible gasto personal: la glosa dice "${palabra}"`;

// ---------------------------------------------------------------- avisos
export const AVISO_XML_AJENO = "El XML no corresponde a este comprobante";
export const AVISO_XML_MONEDA = "El XML está en otra moneda que la fila";

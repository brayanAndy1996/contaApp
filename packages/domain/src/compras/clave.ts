// Clave de identidad de un comprobante de compras (spec 014, D-1): `tipo|SERIE|numero|tipoDoc|DOC`, p. ej.
// `01|F001|1040|6|20100070970`. Serie y documento del proveedor en mayúsculas ASCII y número sin ceros a la izquierda;
// el tipo de comprobante cuenta. Las tres primeras partes son las de `claveNormalizada` (013, D17) y las lee
// `partesDeClave`. La semántica es la de `claveDuplicado` de 012 (mismas normalizaciones), pero la cadena no es la misma
// (aquella es JSON). Quien la usa para persistir rechaza las partes que contengan `|`. No lanza.
import { claveNormalizada, serieNormalizada } from "../clave-comprobante/index";
import type { DocProveedor, IdComprobante } from "../reglas/index";

export function claveComprobante(comprobante: IdComprobante, proveedor: DocProveedor): string {
  return `${claveNormalizada(comprobante.tipo, comprobante.serie, comprobante.numero)}|${proveedor.tipo}|${serieNormalizada(proveedor.numero)}`;
}

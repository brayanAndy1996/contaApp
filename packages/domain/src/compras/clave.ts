// Clave de identidad de un comprobante de compras (spec 014, D-1). Es la misma que usa 012 para marcar
// DUPLICADO: serie en mayúsculas ASCII, número sin ceros a la izquierda y documento del proveedor en
// mayúsculas ASCII; el tipo de comprobante cuenta. La cadena es opaca: solo se compara por igualdad.
import { claveDuplicado } from "../prevalidacion/duplicados";
import type { DocProveedor, IdComprobante } from "../reglas/index";

export function claveComprobante(comprobante: IdComprobante, proveedor: DocProveedor): string {
  return claveDuplicado(comprobante, proveedor);
}

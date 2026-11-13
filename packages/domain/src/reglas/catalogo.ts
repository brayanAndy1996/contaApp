// Catálogo de reglas del motor (021, RF-089, P-8) y RUC aportable (P-10). Puro: sin IO.
// La prevalidación de 012 no figura: no se puede apagar.
import type { CodigoReglaMotor, DocProveedor } from "./tipos";

export interface ReglaMotorCatalogo {
  readonly codigo: CodigoReglaMotor;
  readonly descripcion: string;
}

const regla = (codigo: CodigoReglaMotor, descripcion: string): ReglaMotorCatalogo => Object.freeze({ codigo, descripcion });

/** Las cinco reglas de 011 en `ORDEN_REGLAS` y R-HIS, con una descripción simple para la pantalla del estudio. */
export const CATALOGO_REGLAS_MOTOR: readonly ReglaMotorCatalogo[] = Object.freeze([
  regla("R-ISC", "Detecta montos sin IGV que pueden ser ISC (impuesto selectivo al consumo)."),
  regla("R-MIX", "Detecta comprobantes con una parte gravada y otra no gravada."),
  regla("R-RED", "Detecta descuadres pequeños por redondeo en el total."),
  regla("R-NEW", "Avisa cuando un proveedor no tiene historial en el cliente."),
  regla("R-GP", "Detecta posibles gastos personales por la descripción de los ítems."),
  regla("R-HIS", "Clasifica las compras nuevas según lo aprendido del cliente para cada proveedor."),
]);

/** RUC de persona jurídica: tipo 6 y número de 11 dígitos que empieza en 20. */
const RUC_20 = /^20[0-9]{9}$/;

/** Si el proveedor puede aportar al catálogo compartido (P-10): solo RUC 20. */
export function esRucAportable(doc: DocProveedor): boolean {
  return doc.tipo === "6" && typeof doc.numero === "string" && RUC_20.test(doc.numero);
}

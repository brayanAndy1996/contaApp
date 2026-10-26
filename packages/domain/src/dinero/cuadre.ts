import { MontoInvalidoError } from "./errores";
import { asegurarMismaMoneda, type Moneda } from "./moneda";
import { Money, decimalDeMoney, esMoney } from "./money";
import { type Tolerancia, dentroDeTolerancia } from "./tolerancia";

/** Cualquier fila con total y componentes (compras en 010, ventas en 013, D4). */
export interface Cuadrable {
  readonly moneda: Moneda;
  readonly total: Money;
  componentes(): readonly Money[];
}

export interface ResultadoCuadre {
  cuadra: boolean;
  sumaComponentes: Money;
  total: Money;
  diferencia: Money;
}

/**
 * D2: diferencia = total − Σ componentes; cuadra si |diferencia| ≤ tolerancia. `total` y
 * cada componente deben ser Money reales (marca privada; R2b-6 de la ronda 2). Si Σ o la
 * diferencia exceden NUMERIC(14,2) no hay Money que devolver y lanza MontoFueraDeRangoError
 * (CA-3); quien solo necesita el sí/no lo trata como "no cuadra" (convertirAPen, opción A).
 */
export function verificarCuadre(c: Cuadrable, tol: Tolerancia): ResultadoCuadre {
  const total = c.total;
  if (!esMoney(total)) throw new MontoInvalidoError();
  asegurarMismaMoneda(c.moneda, total.moneda);
  const sumaComponentes = Money.suma(c.componentes(), c.moneda);
  const diferencia = total.restar(sumaComponentes);
  return {
    cuadra: dentroDeTolerancia(decimalDeMoney(diferencia), tol),
    sumaComponentes,
    total,
    diferencia,
  };
}

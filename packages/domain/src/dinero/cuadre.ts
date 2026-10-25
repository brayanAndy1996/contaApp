import { asegurarMismaMoneda, type Moneda } from "./moneda";
import { Money } from "./money";
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

/** D2: diferencia = total − Σ componentes; cuadra si |diferencia| ≤ tolerancia. */
export function verificarCuadre(c: Cuadrable, tol: Tolerancia): ResultadoCuadre {
  const total = c.total;
  asegurarMismaMoneda(c.moneda, total.moneda);
  const sumaComponentes = Money.suma(c.componentes(), c.moneda);
  const diferencia = total.restar(sumaComponentes);
  return {
    cuadra: dentroDeTolerancia(diferencia, tol),
    sumaComponentes,
    total,
    diferencia,
  };
}

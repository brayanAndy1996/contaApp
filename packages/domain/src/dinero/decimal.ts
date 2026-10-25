import { Decimal } from "decimal.js";

// Único punto de entrada a decimal.js en packages/domain (plan 010, "decimal.js aislado").
// `defaults: true` evita heredar cualquier Decimal.set global vigente al cargar.
// D y sus instancias nunca salen de dinero/.
export const D = Decimal.clone({
  defaults: true,
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -9e15,
  toExpPos: 9e15,
});

export type Dec = Decimal;

/** Regla de redondeo SUNAT (D1): half-up alejándose de cero a 2 decimales. */
export function aCentimos(d: Dec): Dec {
  return d.toDecimalPlaces(2, D.ROUND_HALF_UP);
}

/** Quita el signo del cero (-0 → 0). */
export function sinCeroNegativo(d: Dec): Dec {
  return d.isZero() ? new D(0) : d;
}

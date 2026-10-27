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

// Aritmética exacta de MontoExacto (T12, R1b-2 de la ronda 1b): solo productos, sumas,
// restas y división entera, que no se redondean con esta precisión (la máxima de
// decimal.js). Nunca se usa para dividir con decimales periódicos.
const DX = Decimal.clone({
  defaults: true,
  precision: 1e9,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -9e15,
  toExpPos: 9e15,
});

export type Dec = Decimal;

/** Producto exacto (sin redondear a ninguna precisión). */
export function multiplicarExacto(a: Dec, b: Dec): Dec {
  return new DX(a).times(b);
}

/**
 * Regla de redondeo SUNAT (D1) aplicada al cociente exacto num/den (den > 0):
 * half-up alejándose de cero a 2 decimales, sin pasar por un decimal truncado, así
 * que un medio céntimo exacto (p. ej. 0.0099 / 0.18 = 0.055) nunca se pierde.
 */
export function centimosDeCociente(num: Dec, den: Dec): Dec {
  const n = new DX(num).times(100);
  const q = n.dividedToIntegerBy(den); // trunca hacia cero
  const dobleResto = n.minus(q.times(den)).abs().times(2);
  const r = dobleResto.gte(den) ? q.plus(n.isNegative() ? -1 : 1) : q;
  return new D(r.times("0.01"));
}

/** Texto del cociente num/den a 40 dígitos significativos (solo para mostrar). */
export function cocienteATexto(num: Dec, den: Dec): string {
  return new D(num).dividedBy(den).toFixed();
}

/** Quita el signo del cero (-0 → 0). */
export function sinCeroNegativo(d: Dec): Dec {
  return d.isZero() ? new D(0) : d;
}

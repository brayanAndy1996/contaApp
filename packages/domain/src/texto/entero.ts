// Spec 012 (plan, «Lint y cobertura»): conteos, longitudes y posiciones. Este archivo queda fuera
// del lint de dinero (como el resto de texto/) para que prevalidacion/ y formatos/ no escriban
// nunca la palabra prohibida.

/** Solo conteos y longitudes, nunca dinero. */
export type Entero = number;

/** `true` si `x` es un entero seguro mayor o igual que 1 (sin coerción: un string no lo es). */
export function esEnteroPositivo(x: unknown): x is Entero {
  return Number.isSafeInteger(x) && (x as Entero) >= 1;
}

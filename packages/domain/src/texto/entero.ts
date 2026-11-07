// Spec 012 (plan, «Lint y cobertura»): conteos, longitudes y posiciones. Este archivo queda fuera
// del lint de dinero (como el resto de texto/) para que prevalidacion/ y formatos/ no escriban
// nunca la palabra prohibida.

/** Solo conteos y longitudes, nunca dinero. */
export type Entero = number;

/** `true` si `x` es un entero seguro mayor o igual que 1 (sin coerción: un string no lo es). */
export function esEnteroPositivo(x: unknown): x is Entero {
  return Number.isSafeInteger(x) && (x as Entero) >= 1;
}

const DIGITOS_1_A_8 = /^[0-9]{1,8}$/;

/**
 * Entero de una cadena de 1 a 8 dígitos ASCII (ceros a la izquierda permitidos), o `null` si no lo es
 * (spec 013, D7). Vive aquí, fuera del lint contra `number`, para que correlatividad/ no use `Number`.
 */
export function enteroDeDigitos(s: unknown): Entero | null {
  return typeof s === "string" && DIGITOS_1_A_8.test(s) ? Number(s) : null;
}

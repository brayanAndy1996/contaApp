/** Pesos del dígito verificador del RUC (módulo 11) para las 10 primeras cifras. */
const PESOS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2] as const;
const FORMATO = /^(10|15|16|17|20)\d{9}$/;

/**
 * Valida un RUC peruano: 11 dígitos ASCII, prefijo 10/15/16/17/20 y dígito verificador módulo 11.
 * Pura: sin recorte ni coerción; cualquier entrada que no sea un string exacto es inválida.
 */
export function validarRuc(ruc: string): boolean {
  if (typeof ruc !== "string" || !FORMATO.test(ruc)) return false;
  let suma = 0;
  for (let i = 0; i < PESOS.length; i++) {
    suma += Number(ruc[i]) * (PESOS[i] as number);
  }
  const verificador = (11 - (suma % 11)) % 10;
  return verificador === Number(ruc[10]);
}

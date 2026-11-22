// Conversión de una columna USD a soles (spec 013, D11; 010 D7), compartida por el resumen de ventas
// de 013 y los meses SIRE de la prorrata (spec 026, R-2): `redondearSunat(columna × tc)` fila a fila.
// Uso interno de packages/domain (no se exporta en ventas/index).
import { Money, TipoCambio, redondearSunat } from "../dinero/index";

/** Tipo de cambio utilizable de una fila USD, o `null` si falta o no es válido. */
export function tipoCambioUtil(tc: unknown): TipoCambio | null {
  if (typeof tc !== "string" || tc === "") return null;
  try {
    return TipoCambio.desde(tc);
  } catch {
    // TipoCambio.desde solo lanza FactorInvalidoError: un tipo de cambio ilegible equivale a no tenerlo.
    return null;
  }
}

/** Una columna USD (cadena canónica) × tc, redondeada con redondearSunat y reexpresada en PEN. */
export function columnaUsdEnSoles(columna: string, tc: TipoCambio): Money {
  // redondearSunat conserva la moneda (USD): se reexpresa en PEN por su cadena canónica.
  return Money.desde(redondearSunat(Money.desde(columna, "USD").por(tc)).toString(), "PEN");
}

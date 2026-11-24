// Spec 026 (R-3, U-7): cociente de dos montos como porcentaje, con el decimal exacto de dinero/.
// Uso interno de packages/domain (no se exporta en dinero/index): prorrata/porcentaje lo envuelve en
// su `Porcentaje` opaco. Nunca devuelve Decimal ni `number`: solo la cadena canónica.
import { D, centimosDeCociente, multiplicarExacto, sinCeroNegativo } from "./decimal";
import { FactorInvalidoError } from "./errores";
import { asegurarMismaMoneda } from "./moneda";
import { type Money, decimalDeMoney } from "./money";

/**
 * `num / den × 100` redondeado a 2 decimales mitad hacia arriba (alejándose de cero), sin pasar
 * por un cociente truncado: un …,5 exacto en el tercer decimal siempre sube. Ambos deben ser
 * Money reales de la misma moneda y `den > 0`; si no, lanza (MontoInvalidoError,
 * MonedaDistintaError o FactorInvalidoError). Devuelve «-?\d+\.\d{2}» sin -0.00.
 */
export function porcentajeDeCociente(num: Money, den: Money): string {
  const n = decimalDeMoney(num);
  const d = decimalDeMoney(den);
  asegurarMismaMoneda(num.moneda, den.moneda);
  if (!d.gt(0)) throw new FactorInvalidoError();
  return sinCeroNegativo(centimosDeCociente(multiplicarExacto(n, new D(100)), d)).toFixed(2);
}

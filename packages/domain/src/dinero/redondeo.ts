import { centimosDeExacto, type MontoExacto } from "./monto-exacto";
import { type Money, moneyDesdeDecimal } from "./money";

/**
 * Redondeo SUNAT (D1): half-up alejándose de cero a 2 decimales. Única regla del
 * monorepo. Si el resultado excede NUMERIC(14,2) lanza MontoFueraDeRangoError.
 */
export function redondearSunat(x: MontoExacto): Money {
  return moneyDesdeDecimal(centimosDeExacto(x), x.moneda);
}

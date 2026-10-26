import { Factor } from "./factor";
import { asegurarMismaMoneda } from "./moneda";
import { decimalDeMoney, type Money } from "./money";
import { centimosDeExacto } from "./monto-exacto";
import { redondearSunat } from "./redondeo";
import { TOLERANCIA_IGV, type Tolerancia, dentroDeTolerancia } from "./tolerancia";

declare const marcaTasaIgv: unique symbol;
/** Marca nominal: solo TASA_IGV_18 y TASA_IGV_10 tienen este tipo. */
export type TasaIgv = Factor & { readonly [marcaTasaIgv]: true };

export const TASA_IGV_18: TasaIgv = Factor.desde("0.18") as TasaIgv;
export const TASA_IGV_10: TasaIgv = Factor.desde("0.10") as TasaIgv;

/** D3: redondearSunat(base × tasa), en la moneda de la base. */
export function igvEsperado(base: Money, tasa: TasaIgv): Money {
  return redondearSunat(base.por(tasa));
}

/**
 * D2/D3: |igv − igvEsperado(base, tasa)| ≤ tolerancia (por defecto ±0.01). La diferencia se
 * calcula sin límite de rango: si sale de NUMERIC(14,2) no cuadra (false), nunca lanza
 * MontoFueraDeRangoError (R2b-8 de la ronda 2).
 */
export function igvCuadra(
  base: Money,
  igv: Money,
  tasa: TasaIgv,
  tol: Tolerancia = TOLERANCIA_IGV,
): boolean {
  const esperado = centimosDeExacto(base.por(tasa));
  asegurarMismaMoneda(base.moneda, igv.moneda);
  return dentroDeTolerancia(decimalDeMoney(igv).minus(esperado), tol);
}

// Rango del gravado de R-MIX (plan 011, Decisiones: "Rango de R-MIX"; spec D-3, D-7, CA-4).
// Solo API pública de 010: sin `number`, paso de 0.01 en 0.01 en una vecindad acotada.
import { Money, igvEsperado, redondearSunat } from "../dinero/index";
import type { TasaIgv } from "../dinero/index";

/** Gravados posibles, con el signo de la BI; siempre min ≤ max numéricamente. */
export interface RangoGravado {
  readonly min: Money;
  readonly max: Money;
  /** redondearSunat(|IGV| / tasa) acotado al rango. */
  readonly estimado: Money;
}

/**
 * Pasos máximos por lado: el ancho del rango es ≤ 0.01 / tasa (6 céntimos a 18 %, 10 a 10 %).
 * Cota de seguridad; con las tasas de 010 nunca se alcanza.
 */
const PASOS_MAX = 12;

/** a ≤ b */
const menorOIgual = (a: Money, b: Money): boolean => a.comparar(b) <= 0;

/**
 * `{g | igvEsperado(g, tasa) = |IGV|} ∩ [0.01, |BI|]` con el signo de la BI; null si es vacío,
 * si la BI o el IGV son 0 o si tienen signo distinto. BI e IGV deben estar en la misma moneda.
 *
 * Contrato: solo para un IGV que no cuadra exacto a `tasa` con toda la BI (R-MIX solo llama si
 * `igvCuadra` es falso a 18 % y a 10 %). Si igvEsperado(|BI|) = |IGV| no hay mezcla que separar
 * (toda la BI es gravada) y también devuelve null.
 */
export function rangoGravado(bi: Money, igv: Money, tasa: TasaIgv): RangoGravado | null {
  if (bi.esCero() || igv.esCero() || bi.esNegativo() !== igv.esNegativo()) return null;
  const base = bi.abs();
  const objetivo = igv.abs();
  // igvEsperado es monótono en g: si con |BI| no pasa de |IGV|, ningún gravado < |BI| lo alcanza
  // (y con |BI| exacto no hay mezcla).
  if (igvEsperado(base, tasa).comparar(objetivo) <= 0) return null;

  const centimo = Money.desde("0.01", bi.moneda);
  const esMiembro = (g: Money): boolean => igvEsperado(g, tasa).igual(objetivo);
  // |IGV| < igvEsperado(|BI|) ≤ máximo de NUMERIC(14,2) × tasa, así que el estimado no desborda;
  // y es miembro: |e − IGV/tasa| ≤ 0.005 ⇒ |tasa·e − IGV| < 0.005. El rango se recorre desde él.
  const estimado = redondearSunat(objetivo.entre(tasa));
  let hi = estimado;
  let lo = estimado;
  // Los miembros son < |BI| (su IGV esperado es menor que el de |BI|): subir no desborda.
  for (let i = 0; i < PASOS_MAX; i++) {
    const siguiente = hi.sumar(centimo);
    if (!esMiembro(siguiente)) break;
    hi = siguiente;
  }
  // Bajar se detiene a más tardar en 0.00 (igvEsperado 0 ≠ |IGV| > 0): lo ≥ 0.01.
  for (let i = 0; i < PASOS_MAX; i++) {
    const anterior = lo.restar(centimo);
    if (!esMiembro(anterior)) break;
    lo = anterior;
  }
  // El estimado es miembro: ya está acotado al rango [lo, hi].
  if (!bi.esNegativo()) return Object.freeze({ min: lo, max: hi, estimado });
  return Object.freeze({ min: hi.negar(), max: lo.negar(), estimado: estimado.negar() });
}

/** min ≤ g ≤ max (misma moneda; si no, MonedaDistintaError de 010). */
export function enRango(g: Money, r: RangoGravado): boolean {
  return menorOIgual(r.min, g) && menorOIgual(g, r.max);
}

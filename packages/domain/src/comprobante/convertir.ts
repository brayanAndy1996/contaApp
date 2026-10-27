// Conversión USD → PEN (plan 010, Decisiones: Conversión; D7).
import {
  ComprobanteDescuadradoError,
  Money,
  MonedaDistintaError,
  MontoFueraDeRangoError,
  redondearSunat,
  TOLERANCIA_CUADRE,
  verificarCuadre,
} from "../dinero/index";
import type { TipoCambio } from "../dinero/index";
import { COLUMNAS_COMPRA } from "./columnas";
import type { ColumnaCompra } from "./columnas";
import { copiarColumnas, montosDesdeColumnas } from "./montos-comprobante";
import type { MontosComprobante } from "./montos-comprobante";

/**
 * Cuadre exacto (TOLERANCIA_CUADRE = 0.00) de un MontosComprobante real ya validado. Con un
 * comprobante real (total y columnas Money de su moneda) y una tolerancia constante, el
 * único error posible de verificarCuadre es MontoFueraDeRangoError: Σ o total − Σ exceden
 * NUMERIC(14,2), y como total está en rango eso implica total ≠ Σ, o sea, no cuadra
 * (R2a-5/R2b-8 de la ronda 2).
 */
function cuadraExacto(m: MontosComprobante): boolean {
  try {
    return verificarCuadre(m, TOLERANCIA_CUADRE).cuadra;
  } catch (e) {
    if (e instanceof MontoFueraDeRangoError) return false;
    throw e;
  }
}

/**
 * Exige un MontosComprobante real (marca privada; R2a-4) en USD que cuadre con
 * TOLERANCIA_CUADRE (D2; decisión del usuario, opción A de R1b-5): si no cuadra lanza
 * ComprobanteDescuadradoError antes de convertir y antes que cualquier error de rango.
 * Cada columna = redondearSunat(columna × tc) en PEN; total = suma de las columnas
 * convertidas (no el total USD convertido).
 */
export function convertirAPen(m: MontosComprobante, tc: TipoCambio): MontosComprobante {
  const origen = copiarColumnas(m);
  if (m.moneda !== "USD") throw new MonedaDistintaError();
  if (!cuadraExacto(m)) throw new ComprobanteDescuadradoError();
  const columnas = {} as Record<ColumnaCompra, Money>;
  for (const c of COLUMNAS_COMPRA) {
    // redondearSunat conserva la moneda (USD): se reexpresa en PEN por su string canónico.
    columnas[c] = Money.desde(redondearSunat(origen[c].por(tc)).toString(), "PEN");
  }
  const total = Money.suma(
    COLUMNAS_COMPRA.map((c) => columnas[c]),
    "PEN",
  );
  return montosDesdeColumnas("PEN", columnas, total);
}

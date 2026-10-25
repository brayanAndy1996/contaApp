// Conversión USD → PEN (plan 010, Decisiones: Conversión; D7).
import { Money, MonedaDistintaError, redondearSunat } from "../dinero/index";
import type { TipoCambio } from "../dinero/index";
import { COLUMNAS_COMPRA } from "./columnas";
import type { ColumnaCompra } from "./columnas";
import { montosDesdeColumnas } from "./montos-comprobante";
import type { MontosComprobante } from "./montos-comprobante";

/**
 * Cada columna = redondearSunat(columna × tc) en PEN; total = suma de las columnas
 * convertidas (no el total USD convertido). Exige un comprobante en USD.
 */
export function convertirAPen(m: MontosComprobante, tc: TipoCambio): MontosComprobante {
  if (m.moneda !== "USD") throw new MonedaDistintaError();
  const columnas = {} as Record<ColumnaCompra, Money>;
  for (const c of COLUMNAS_COMPRA) {
    // redondearSunat conserva la moneda (USD): se reexpresa en PEN por su string canónico.
    columnas[c] = Money.desde(redondearSunat(m.obtener(c).por(tc)).toString(), "PEN");
  }
  const total = Money.suma(
    COLUMNAS_COMPRA.map((c) => columnas[c]),
    "PEN",
  );
  return montosDesdeColumnas("PEN", columnas, total);
}

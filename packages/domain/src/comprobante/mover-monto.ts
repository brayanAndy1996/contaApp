// Movimiento de un monto entre columnas (plan 010, Decisiones: Movimientos; D4, D6).
import { MonedaDistintaError, Money, MovimientoInvalidoError } from "../dinero/index";
import { esColumnaCompra } from "./columnas";
import type { ColumnaCompra } from "./columnas";
import { copiarColumnas, montosDesdeColumnas } from "./montos-comprobante";
import type { MontosComprobante } from "./montos-comprobante";

/**
 * Mueve `monto` de `origen` a `destino`; el total no cambia. Exige misma moneda,
 * origen ≠ destino, monto ≠ 0, mismo signo que el saldo de origen y |monto| ≤ |saldo|
 * (saldo 0.00 → siempre inválido). Notas de crédito: saldo y monto negativos (D6).
 */
export function moverMonto(
  m: MontosComprobante,
  origen: ColumnaCompra,
  destino: ColumnaCompra,
  monto: Money,
): MontosComprobante {
  if (!(monto instanceof Money) || monto.moneda !== m.moneda) throw new MonedaDistintaError();
  if (!esColumnaCompra(origen) || !esColumnaCompra(destino) || origen === destino) {
    throw new MovimientoInvalidoError();
  }
  const columnas = copiarColumnas(m);
  const saldo = columnas[origen];
  if (
    monto.esCero() ||
    saldo.esCero() ||
    monto.esNegativo() !== saldo.esNegativo() ||
    monto.abs().comparar(saldo.abs()) > 0
  ) {
    throw new MovimientoInvalidoError();
  }
  columnas[origen] = saldo.restar(monto);
  columnas[destino] = columnas[destino].sumar(monto);
  return montosDesdeColumnas(m.moneda, columnas, m.total);
}

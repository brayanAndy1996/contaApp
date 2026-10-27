// Movimiento de un monto entre columnas (plan 010, Decisiones: Movimientos; D4, D6).
import { Money, MovimientoInvalidoError } from "../dinero/index";
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
  // Money.suma de un solo sumando valida por marca privada (no `instanceof`; R2a-4 de la
  // ronda 2) que `monto` sea un Money real en la moneda de `m`; si no, MonedaDistintaError.
  const real = Money.suma([monto], m.moneda);
  if (!esColumnaCompra(origen) || !esColumnaCompra(destino) || origen === destino) {
    throw new MovimientoInvalidoError();
  }
  const columnas = copiarColumnas(m);
  const saldo = columnas[origen];
  if (
    real.esCero() ||
    saldo.esCero() ||
    real.esNegativo() !== saldo.esNegativo() ||
    real.abs().comparar(saldo.abs()) > 0
  ) {
    throw new MovimientoInvalidoError();
  }
  columnas[origen] = saldo.restar(real);
  columnas[destino] = columnas[destino].sumar(real);
  return montosDesdeColumnas(m.moneda, columnas, m.total);
}

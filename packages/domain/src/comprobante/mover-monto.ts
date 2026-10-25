// STUB (T6, rojo): lo implementa T9.
import type { Money } from "../dinero/index";
import type { ColumnaCompra } from "./columnas";
import type { MontosComprobante } from "./montos-comprobante";

export function moverMonto(
  _m: MontosComprobante,
  _origen: ColumnaCompra,
  _destino: ColumnaCompra,
  _monto: Money,
): MontosComprobante {
  throw new Error("no implementado (T9)");
}

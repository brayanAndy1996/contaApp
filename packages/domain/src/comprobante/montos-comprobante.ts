// STUB (T6, rojo): lo implementa T9.
import type { Cuadrable, Moneda, Money } from "../dinero/index";
import type { ColumnaCompra } from "./columnas";

export class MontosComprobante implements Cuadrable {
  readonly moneda!: Moneda;
  readonly total!: Money;

  static desde(
    _moneda: Moneda,
    _v: Partial<Record<ColumnaCompra, string>> & { total: string },
  ): MontosComprobante {
    throw new Error("no implementado (T9)");
  }

  componentes(): readonly Money[] {
    throw new Error("no implementado (T9)");
  }

  obtener(_c: ColumnaCompra): Money {
    throw new Error("no implementado (T9)");
  }

  sumar(_o: MontosComprobante): MontosComprobante {
    throw new Error("no implementado (T9)");
  }

  toJSON(): { moneda: Moneda; total: string; columnas: Record<ColumnaCompra, string> } {
    throw new Error("no implementado (T9)");
  }
}

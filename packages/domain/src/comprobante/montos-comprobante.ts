// Montos de un comprobante de compras (plan 010, Contratos; Decisiones: Inmutabilidad).
import {
  MonedaDistintaError,
  MontoInvalidoError,
  Money,
} from "../dinero/index";
import type { Cuadrable, Moneda } from "../dinero/index";
import { COLUMNAS_COMPRA, esColumnaCompra } from "./columnas";
import type { ColumnaCompra } from "./columnas";

export type ColumnasMoney = Readonly<Record<ColumnaCompra, Money>>;

let crearMontos: (moneda: Moneda, columnas: ColumnasMoney, total: Money) => MontosComprobante;

export class MontosComprobante implements Cuadrable {
  readonly #columnas: ColumnasMoney;
  readonly moneda: Moneda;
  readonly total: Money;

  /**
   * Único constructor: copia y congela el registro. Solo lo llaman `desde`, `sumar` y
   * `montosDesdeColumnas` (interno), que ya entregan columnas y total en `moneda`.
   */
  private constructor(moneda: Moneda, columnas: ColumnasMoney, total: Money) {
    const copia = {} as Record<ColumnaCompra, Money>;
    for (const c of COLUMNAS_COMPRA) copia[c] = columnas[c];
    this.#columnas = Object.freeze(copia);
    this.moneda = moneda;
    this.total = total;
    Object.freeze(this);
  }

  /** Columna faltante = 0.00; clave desconocida o valor no string → MontoInvalidoError. */
  static desde(
    moneda: Moneda,
    v: Partial<Record<ColumnaCompra, string>> & { total: string },
  ): MontosComprobante {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      throw new MontoInvalidoError();
    }
    for (const k of Object.keys(v)) {
      if (k !== "total" && !esColumnaCompra(k)) throw new MontoInvalidoError();
    }
    if (!Object.hasOwn(v, "total")) throw new MontoInvalidoError();
    const total = Money.desde(v.total, moneda);
    const columnas = {} as Record<ColumnaCompra, Money>;
    for (const c of COLUMNAS_COMPRA) {
      columnas[c] = Object.hasOwn(v, c)
        ? Money.desde(v[c] as string, moneda)
        : Money.cero(moneda);
    }
    return new MontosComprobante(total.moneda, columnas, total);
  }

  obtener(c: ColumnaCompra): Money {
    if (!esColumnaCompra(c)) throw new MontoInvalidoError();
    return this.#columnas[c];
  }

  /** Arreglo congelado nuevo en cada llamada, en el orden de COLUMNAS_COMPRA. */
  componentes(): readonly Money[] {
    return Object.freeze(COLUMNAS_COMPRA.map((c) => this.#columnas[c]));
  }

  /** Suma por columna y total; exige la misma moneda. */
  sumar(o: MontosComprobante): MontosComprobante {
    if (!(o instanceof MontosComprobante) || o.moneda !== this.moneda) {
      throw new MonedaDistintaError();
    }
    const columnas = {} as Record<ColumnaCompra, Money>;
    for (const c of COLUMNAS_COMPRA) {
      columnas[c] = this.#columnas[c].sumar(o.#columnas[c]);
    }
    return new MontosComprobante(this.moneda, columnas, this.total.sumar(o.total));
  }

  toJSON(): { moneda: Moneda; total: string; columnas: Record<ColumnaCompra, string> } {
    const columnas = {} as Record<ColumnaCompra, string>;
    for (const c of COLUMNAS_COMPRA) columnas[c] = this.#columnas[c].toString();
    return { moneda: this.moneda, total: this.total.toString(), columnas };
  }

  static {
    crearMontos = (moneda, columnas, total) => new MontosComprobante(moneda, columnas, total);
  }
}

/** Uso interno de comprobante/: crea un MontosComprobante desde columnas ya en Money. */
export function montosDesdeColumnas(
  moneda: Moneda,
  columnas: ColumnasMoney,
  total: Money,
): MontosComprobante {
  return crearMontos(moneda, columnas, total);
}

/** Uso interno de comprobante/: copia mutable de las columnas. */
export function copiarColumnas(m: MontosComprobante): Record<ColumnaCompra, Money> {
  const copia = {} as Record<ColumnaCompra, Money>;
  for (const c of COLUMNAS_COMPRA) copia[c] = m.obtener(c);
  return copia;
}

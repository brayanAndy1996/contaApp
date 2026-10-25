import { D, type Dec, sinCeroNegativo } from "./decimal";
import { FactorInvalidoError, MontoInvalidoError } from "./errores";
import type { Factor } from "./factor";
import { asegurarMoneda, type Moneda } from "./moneda";
import { type TipoCambio, decimalDeMultiplicador } from "./tipo-cambio";

// Valor sin redondear (productos, divisiones, importes del XML UBL). Solo sale de aquí
// como Money a través de redondearSunat. `desde` acepta hasta 12 enteros y 10 decimales.
const GRAMATICA_EXACTO = /^-?(0|[1-9][0-9]{0,11})(\.[0-9]{1,10})?$/;
const LARGO_MAX_EXACTO = 24;

let crearExacto: (d: Dec, moneda: Moneda) => MontoExacto;
let leerExacto: (x: MontoExacto) => Dec;

export class MontoExacto {
  readonly #d: Dec;
  readonly moneda: Moneda;

  private constructor(d: Dec, moneda: Moneda) {
    this.#d = sinCeroNegativo(d);
    this.moneda = moneda;
    Object.freeze(this);
  }

  static desde(valor: string, moneda: Moneda): MontoExacto {
    if (
      typeof valor !== "string" ||
      valor.length > LARGO_MAX_EXACTO ||
      !GRAMATICA_EXACTO.test(valor)
    ) {
      throw new MontoInvalidoError();
    }
    return new MontoExacto(new D(valor), asegurarMoneda(moneda));
  }

  por(f: Factor | TipoCambio): MontoExacto {
    return new MontoExacto(this.#d.times(decimalDeMultiplicador(f)), this.moneda);
  }

  entre(f: Factor): MontoExacto {
    return new MontoExacto(dividir(this.#d, f), this.moneda);
  }

  toString(): string {
    return this.#d.toFixed();
  }

  toJSON(): never {
    throw new TypeError(
      "MontoExacto no se serializa sin redondear: usa redondearSunat.",
    );
  }

  [Symbol.toPrimitive](hint: string): string {
    if (hint === "string") return this.toString();
    throw new TypeError("MontoExacto no se opera como número: usa sus métodos.");
  }

  static {
    crearExacto = (d, moneda) => new MontoExacto(d, moneda);
    leerExacto = (x) => x.#d;
  }
}

/** División exacta (precisión 40, sin redondear a céntimos); divisor > 0. */
export function dividir(d: Dec, f: Factor): Dec {
  const divisor = decimalDeMultiplicador(f);
  if (divisor.isZero()) throw new FactorInvalidoError();
  return d.dividedBy(divisor);
}

/** Uso interno de dinero/. */
export function exactoDesdeDecimal(d: Dec, moneda: Moneda): MontoExacto {
  return crearExacto(d, moneda);
}

/** Uso interno de dinero/: lanza MontoInvalidoError si `x` no es un MontoExacto. */
export function decimalDeExacto(x: MontoExacto): Dec {
  if (!(x instanceof MontoExacto)) throw new MontoInvalidoError();
  return leerExacto(x);
}

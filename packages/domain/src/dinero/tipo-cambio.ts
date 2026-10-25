import { D, type Dec } from "./decimal";
import { FactorInvalidoError } from "./errores";
import { Factor, decimalDeFactor } from "./factor";

// D7: hasta 4 enteros y 3 decimales, mayor que cero. Solo dígitos ASCII.
const GRAMATICA_TC = /^(0|[1-9][0-9]{0,3})(\.[0-9]{1,3})?$/;
const LARGO_MAX_TC = 8;

let leerTipoCambio: (t: TipoCambio) => Dec;

export class TipoCambio {
  readonly #d: Dec;

  private constructor(d: Dec) {
    this.#d = d;
    Object.freeze(this);
  }

  static desde(s: string): TipoCambio {
    if (
      typeof s !== "string" ||
      s.length > LARGO_MAX_TC ||
      !GRAMATICA_TC.test(s)
    ) {
      throw new FactorInvalidoError();
    }
    const d = new D(s);
    if (d.isZero()) throw new FactorInvalidoError();
    return new TipoCambio(d);
  }

  static {
    leerTipoCambio = (t) => t.#d;
  }
}

/** Uso interno de dinero/: valor decimal de un Factor o TipoCambio. */
export function decimalDeMultiplicador(f: Factor | TipoCambio): Dec {
  if (f instanceof TipoCambio) return leerTipoCambio(f);
  if (f instanceof Factor) return decimalDeFactor(f);
  throw new FactorInvalidoError();
}

import { D, type Dec } from "./decimal";
import { FactorInvalidoError } from "./errores";

// Hasta 6 enteros y 10 decimales, sin signo (plan 010). Solo dígitos ASCII.
const GRAMATICA_FACTOR = /^(0|[1-9][0-9]{0,5})(\.[0-9]{1,10})?$/;
const LARGO_MAX_FACTOR = 17;

let leerFactor: (f: Factor) => Dec;

export class Factor {
  readonly #d: Dec;

  private constructor(d: Dec) {
    this.#d = d;
    Object.freeze(this);
  }

  static desde(s: string): Factor {
    if (
      typeof s !== "string" ||
      s.length > LARGO_MAX_FACTOR ||
      !GRAMATICA_FACTOR.test(s)
    ) {
      throw new FactorInvalidoError();
    }
    return new Factor(new D(s));
  }

  static {
    leerFactor = (f) => f.#d;
  }
}

/** Uso interno de dinero/: valor decimal de un Factor. */
export function decimalDeFactor(f: Factor): Dec {
  return leerFactor(f);
}

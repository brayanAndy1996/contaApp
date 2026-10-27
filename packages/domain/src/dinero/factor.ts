import { D, type Dec } from "./decimal";
import { FactorInvalidoError } from "./errores";

// Hasta 6 enteros y 10 decimales, sin signo (plan 010). Solo dígitos ASCII.
const GRAMATICA_FACTOR = /^(0|[1-9][0-9]{0,5})(\.[0-9]{1,10})?$/;
const LARGO_MAX_FACTOR = 17;

// Clave de módulo: el constructor solo se invoca desde este archivo (R1b-3 de la ronda 1b).
const CLAVE = Symbol("Factor");

let leerFactor: (f: Factor) => Dec;
let tieneEstadoFactor: (o: object) => boolean;

export class Factor {
  readonly #d: Dec;

  private constructor(clave: symbol, d: Dec) {
    if (clave !== CLAVE) {
      throw new TypeError("Constructor privado: usa Factor.desde.");
    }
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
    return new Factor(CLAVE, new D(s));
  }

  static {
    leerFactor = (f) => f.#d;
    tieneEstadoFactor = (o) => #d in o;
  }
}
// La clase y su prototipo no se pueden parchear (R2b-2 de la ronda 2).
Object.freeze(Factor);
Object.freeze(Factor.prototype);

/** Uso interno de dinero/: marca privada de Factor (no `instanceof`; R2a-4 de la ronda 2). */
export function esFactor(o: unknown): o is Factor {
  return typeof o === "object" && o !== null && tieneEstadoFactor(o);
}

/** Uso interno de dinero/: valor decimal de un Factor. */
export function decimalDeFactor(f: Factor): Dec {
  return leerFactor(f);
}

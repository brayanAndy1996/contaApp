import { D, type Dec } from "./decimal";
import { MontoInvalidoError } from "./errores";
import { decimalDeMoney, type Money } from "./money";

// ≥ 0 y a lo más 2 decimales (D2). Solo dígitos ASCII, sin signo.
const GRAMATICA_TOLERANCIA = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$/;
const LARGO_MAX_TOLERANCIA = 15;

// Clave de módulo: el constructor solo se invoca desde este archivo (R1b-3 de la ronda 1b).
const CLAVE = Symbol("Tolerancia");

let leerTolerancia: (t: Tolerancia) => Dec;

export class Tolerancia {
  readonly #d: Dec;

  private constructor(clave: symbol, d: Dec) {
    if (clave !== CLAVE) {
      throw new TypeError("Constructor privado: usa Tolerancia.desde.");
    }
    this.#d = d;
    Object.freeze(this);
  }

  static desde(s: string): Tolerancia {
    if (
      typeof s !== "string" ||
      s.length > LARGO_MAX_TOLERANCIA ||
      !GRAMATICA_TOLERANCIA.test(s)
    ) {
      throw new MontoInvalidoError();
    }
    return new Tolerancia(CLAVE, new D(s));
  }

  static {
    leerTolerancia = (t) => t.#d;
  }
}

/** D2: 0.00 para el cuadre total = Σ componentes. */
export const TOLERANCIA_CUADRE: Tolerancia = Tolerancia.desde("0.00");
/** D2: ±0.01 solo para IGV contra base × tasa. */
export const TOLERANCIA_IGV: Tolerancia = Tolerancia.desde("0.01");

/** Uso interno de dinero/: |diferencia| ≤ tolerancia (inclusivo). */
export function dentroDeTolerancia(diferencia: Money, tol: Tolerancia): boolean {
  if (!(tol instanceof Tolerancia)) throw new MontoInvalidoError();
  return decimalDeMoney(diferencia).abs().lte(leerTolerancia(tol));
}

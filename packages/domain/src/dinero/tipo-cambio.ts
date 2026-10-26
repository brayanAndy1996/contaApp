import { D, type Dec } from "./decimal";
import { FactorInvalidoError } from "./errores";
import { type Factor, decimalDeFactor, esFactor } from "./factor";

// D7: hasta 4 enteros y 3 decimales, mayor que cero. Solo dígitos ASCII.
const GRAMATICA_TC = /^(0|[1-9][0-9]{0,3})(\.[0-9]{1,3})?$/;
const LARGO_MAX_TC = 8;

// Clave de módulo: el constructor solo se invoca desde este archivo (R1b-3 de la ronda 1b).
const CLAVE = Symbol("TipoCambio");

let leerTipoCambio: (t: TipoCambio) => Dec;
let tieneEstadoTipoCambio: (o: object) => boolean;

export class TipoCambio {
  readonly #d: Dec;

  private constructor(clave: symbol, d: Dec) {
    if (clave !== CLAVE) {
      throw new TypeError("Constructor privado: usa TipoCambio.desde.");
    }
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
    return new TipoCambio(CLAVE, d);
  }

  static {
    leerTipoCambio = (t) => t.#d;
    tieneEstadoTipoCambio = (o) => #d in o;
  }
}
// La clase y su prototipo no se pueden parchear (R2b-2 de la ronda 2).
Object.freeze(TipoCambio);
Object.freeze(TipoCambio.prototype);

/**
 * Uso interno de dinero/: valor decimal de un Factor o TipoCambio reales (marca privada,
 * no `instanceof`; R2a-4 de la ronda 2).
 */
export function decimalDeMultiplicador(f: Factor | TipoCambio): Dec {
  if (esFactor(f)) return decimalDeFactor(f);
  if (typeof f === "object" && f !== null && tieneEstadoTipoCambio(f)) {
    return leerTipoCambio(f);
  }
  throw new FactorInvalidoError();
}

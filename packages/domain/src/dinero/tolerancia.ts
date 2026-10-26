import { D, type Dec } from "./decimal";
import { MontoInvalidoError } from "./errores";

// ≥ 0 y a lo más 2 decimales (D2). Solo dígitos ASCII, sin signo.
const GRAMATICA_TOLERANCIA = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$/;
const LARGO_MAX_TOLERANCIA = 15;

// Clave de módulo: el constructor solo se invoca desde este archivo (R1b-3 de la ronda 1b).
const CLAVE = Symbol("Tolerancia");

let leerTolerancia: (t: Tolerancia) => Dec;
let tieneEstadoTolerancia: (o: object) => boolean;

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
    tieneEstadoTolerancia = (o) => #d in o;
  }
}
// La clase y su prototipo no se pueden parchear (R2b-2 de la ronda 2).
Object.freeze(Tolerancia);
Object.freeze(Tolerancia.prototype);

/** D2: 0.00 para el cuadre total = Σ componentes. */
export const TOLERANCIA_CUADRE: Tolerancia = Tolerancia.desde("0.00");
/** D2: ±0.01 solo para IGV contra base × tasa. */
export const TOLERANCIA_IGV: Tolerancia = Tolerancia.desde("0.01");

/**
 * Uso interno de dinero/: |diferencia| ≤ tolerancia (inclusivo). La diferencia es un
 * decimal sin límite de rango: una diferencia fuera de NUMERIC(14,2) simplemente no cuadra
 * (R2a-5/R2b-8 de la ronda 2). `tol` se valida por marca privada, no por `instanceof`.
 */
export function dentroDeTolerancia(diferencia: Dec, tol: Tolerancia): boolean {
  if (typeof tol !== "object" || tol === null || !tieneEstadoTolerancia(tol)) {
    throw new MontoInvalidoError();
  }
  return diferencia.abs().lte(leerTolerancia(tol));
}

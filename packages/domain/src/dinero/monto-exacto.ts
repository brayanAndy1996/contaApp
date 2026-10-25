import {
  D,
  type Dec,
  centimosDeCociente,
  cocienteATexto,
  multiplicarExacto,
  sinCeroNegativo,
} from "./decimal";
import { FactorInvalidoError, MontoInvalidoError } from "./errores";
import type { Factor } from "./factor";
import { asegurarMoneda, type Moneda } from "./moneda";
import { type TipoCambio, decimalDeMultiplicador } from "./tipo-cambio";

// Valor sin redondear (productos, divisiones, importes del XML UBL). Solo sale de aquí
// como Money a través de redondearSunat. `desde` acepta hasta 12 enteros y 10 decimales.
// Se guarda como fracción exacta num/den (den > 0): `por` multiplica num y `entre`
// multiplica den, así que una cadena entre → por nunca trunca un medio céntimo (D1).
const GRAMATICA_EXACTO = /^-?(0|[1-9][0-9]{0,11})(\.[0-9]{1,10})?$/;
const LARGO_MAX_EXACTO = 24;
const UNO = new D(1);

// Clave de módulo: el constructor solo se invoca desde este archivo (R1b-3 de la ronda 1b).
const CLAVE = Symbol("MontoExacto");

let crearExacto: (num: Dec, moneda: Moneda) => MontoExacto;
let leerFraccion: (x: MontoExacto) => readonly [Dec, Dec];

export class MontoExacto {
  readonly #num: Dec;
  readonly #den: Dec;
  readonly moneda: Moneda;

  private constructor(clave: symbol, num: Dec, den: Dec, moneda: Moneda) {
    if (clave !== CLAVE) {
      throw new TypeError("Constructor privado: usa MontoExacto.desde.");
    }
    this.#num = sinCeroNegativo(num);
    this.#den = den;
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
    return new MontoExacto(CLAVE, new D(valor), UNO, asegurarMoneda(moneda));
  }

  por(f: Factor | TipoCambio): MontoExacto {
    return new MontoExacto(
      CLAVE,
      multiplicarExacto(this.#num, decimalDeMultiplicador(f)),
      this.#den,
      this.moneda,
    );
  }

  /** División exacta por un Factor > 0, sin redondear. */
  entre(f: Factor): MontoExacto {
    const divisor = decimalDeMultiplicador(f);
    if (divisor.isZero()) throw new FactorInvalidoError();
    return new MontoExacto(
      CLAVE,
      this.#num,
      multiplicarExacto(this.#den, divisor),
      this.moneda,
    );
  }

  toString(): string {
    return cocienteATexto(this.#num, this.#den);
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
    crearExacto = (num, moneda) => new MontoExacto(CLAVE, num, UNO, moneda);
    leerFraccion = (x) => [x.#num, x.#den];
  }
}

/** Uso interno de dinero/: MontoExacto con el valor exacto `d` (Money ya validado). */
export function exactoDesdeDecimal(d: Dec, moneda: Moneda): MontoExacto {
  return crearExacto(d, moneda);
}

/**
 * Uso interno de dinero/: redondeo SUNAT (D1) exacto de `x` a céntimos; lanza
 * MontoInvalidoError si `x` no es un MontoExacto.
 */
export function centimosDeExacto(x: MontoExacto): Dec {
  if (!(x instanceof MontoExacto)) throw new MontoInvalidoError();
  const [num, den] = leerFraccion(x);
  return centimosDeCociente(num, den);
}

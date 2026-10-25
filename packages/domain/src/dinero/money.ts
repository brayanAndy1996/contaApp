import { D, type Dec, sinCeroNegativo } from "./decimal";
import {
  MonedaDistintaError,
  MontoFueraDeRangoError,
  MontoInvalidoError,
} from "./errores";
import type { Factor } from "./factor";
import { asegurarMismaMoneda, asegurarMoneda, type Moneda } from "./moneda";
import { exactoDesdeDecimal, type MontoExacto } from "./monto-exacto";
import type { TipoCambio } from "./tipo-cambio";

// Gramática canónica (D5, D8): signo opcional, hasta 12 enteros sin ceros a la izquierda,
// hasta 2 decimales. Solo dígitos ASCII; la longitud se comprueba antes del regex.
const GRAMATICA_MONTO = /^-?(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$/;
const LARGO_MAX_MONTO = 16;
const LIMITE = new D("999999999999.99");

// Clave de módulo: el constructor solo se invoca desde este archivo (R1b-3 de la ronda 1b).
const CLAVE = Symbol("Money");

let crearMoney: (d: Dec, moneda: Moneda) => Money;
let leerMoney: (m: Money) => Dec;

function parsear(valor: unknown): Dec {
  if (
    typeof valor !== "string" ||
    valor.length > LARGO_MAX_MONTO ||
    !GRAMATICA_MONTO.test(valor)
  ) {
    throw new MontoInvalidoError();
  }
  return new D(valor);
}

export class Money {
  readonly #d: Dec;
  readonly moneda: Moneda;

  /** Único constructor: valida el rango de NUMERIC(14,2) y quita el cero negativo. */
  private constructor(clave: symbol, d: Dec, moneda: Moneda) {
    if (clave !== CLAVE) {
      throw new TypeError("Constructor privado: usa Money.desde.");
    }
    if (d.abs().gt(LIMITE)) throw new MontoFueraDeRangoError();
    this.#d = sinCeroNegativo(d);
    this.moneda = moneda;
    Object.freeze(this);
  }

  static desde(valor: string, moneda: Moneda): Money {
    return new Money(CLAVE, parsear(valor), asegurarMoneda(moneda));
  }

  /** Lo que PostgreSQL devuelve para NUMERIC(14,2): misma gramática y rango. */
  static desdeNumeric(valor: string, moneda: Moneda): Money {
    return Money.desde(valor, moneda);
  }

  /** Inverso estricto de toJSON: { monto: string, moneda }, sin claves extra. */
  static desdeJSON(j: unknown): Money {
    if (typeof j !== "object" || j === null || Array.isArray(j)) {
      throw new MontoInvalidoError();
    }
    const claves = Object.keys(j);
    if (
      claves.length !== 2 ||
      !Object.hasOwn(j, "monto") ||
      !Object.hasOwn(j, "moneda")
    ) {
      throw new MontoInvalidoError();
    }
    const { monto, moneda } = j as { monto: unknown; moneda: unknown };
    return new Money(CLAVE, parsear(monto), asegurarMoneda(moneda));
  }

  static cero(moneda: Moneda): Money {
    return new Money(CLAVE, new D(0), asegurarMoneda(moneda));
  }

  /** Suma exacta; el rango se comprueba solo en el resultado (no depende del orden). */
  static suma(lista: readonly Money[], moneda: Moneda): Money {
    const m = asegurarMoneda(moneda);
    let acumulado = new D(0);
    for (const x of lista) {
      if (!(x instanceof Money) || x.moneda !== m) {
        throw new MonedaDistintaError();
      }
      acumulado = acumulado.plus(x.#d);
    }
    return new Money(CLAVE, acumulado, m);
  }

  sumar(o: Money): Money {
    asegurarMismaMoneda(this.moneda, o.moneda);
    return new Money(CLAVE, this.#d.plus(o.#d), this.moneda);
  }

  restar(o: Money): Money {
    asegurarMismaMoneda(this.moneda, o.moneda);
    return new Money(CLAVE, this.#d.minus(o.#d), this.moneda);
  }

  negar(): Money {
    return new Money(CLAVE, this.#d.negated(), this.moneda);
  }

  abs(): Money {
    return new Money(CLAVE, this.#d.abs(), this.moneda);
  }

  /** Producto sin redondear: pasa por redondearSunat para volver a Money. */
  por(f: Factor | TipoCambio): MontoExacto {
    return exactoDesdeDecimal(this.#d, this.moneda).por(f);
  }

  /** División exacta por un Factor > 0, sin redondear. */
  entre(f: Factor): MontoExacto {
    return exactoDesdeDecimal(this.#d, this.moneda).entre(f);
  }

  comparar(o: Money): -1 | 0 | 1 {
    asegurarMismaMoneda(this.moneda, o.moneda);
    if (this.#d.lt(o.#d)) return -1;
    return this.#d.gt(o.#d) ? 1 : 0;
  }

  igual(o: Money): boolean {
    return this.comparar(o) === 0;
  }

  esCero(): boolean {
    return this.#d.isZero();
  }

  esNegativo(): boolean {
    return this.#d.isNegative();
  }

  /** Canónico: -?\d{1,12}\.\d{2}, sin exponente ni -0.00. */
  toString(): string {
    return this.#d.toFixed(2);
  }

  toJSON(): { monto: string; moneda: Moneda } {
    return { monto: this.toString(), moneda: this.moneda };
  }

  /** Solo se convierte a string: `a + b`, `a < b` y `+a` lanzan. */
  [Symbol.toPrimitive](hint: string): string {
    if (hint === "string") return this.toString();
    throw new TypeError("Money no se opera como número: usa sus métodos.");
  }

  static {
    crearMoney = (d, moneda) => new Money(CLAVE, d, moneda);
    leerMoney = (m) => m.#d;
  }
}

/** Uso interno de dinero/: crea un Money desde un decimal ya en céntimos (valida rango). */
export function moneyDesdeDecimal(d: Dec, moneda: Moneda): Money {
  return crearMoney(d, moneda);
}

/** Uso interno de dinero/. */
export function decimalDeMoney(m: Money): Dec {
  return leerMoney(m);
}

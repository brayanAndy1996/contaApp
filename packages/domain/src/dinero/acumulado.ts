// Suma exacta SIN el tope de NUMERIC(14,2) (spec 026, H-026-2-3 y H-026-2-4). Uso interno de packages/domain (no se exporta en
// dinero/index): la prorrata suma columnas y meses que por separado caben en NUMERIC(14,2) pero cuyo acumulado puede no caber, y
// necesita saberlo sin lanzar. Opaco como Money: el Decimal no sale de dinero/.
import { D, type Dec } from "./decimal";
import { MontoInvalidoError } from "./errores";
import type { Moneda } from "./moneda";
import { type Money, decimalDeMoney, moneyDesdeDecimal } from "./money";
import { centimosDeExacto } from "./monto-exacto";
import type { TipoCambio } from "./tipo-cambio";

const LIMITE = new D("999999999999.99");
// Lo que PostgreSQL devuelve para un SUM de NUMERIC(14,2) (escala 2): la gramática de Money sin el tope de 12 enteros (hasta 30,
// de sobra para cualquier número de filas). Solo dígitos ASCII; nunca `number`, exponente ni espacios.
const GRAMATICA_SUMA = /^-?(0|[1-9][0-9]{0,29})(\.[0-9]{1,2})?$/;

// Clave de módulo: el constructor solo se invoca desde este archivo (como Money).
const CLAVE = Symbol("Acumulado");

export class Acumulado {
  readonly #d: Dec;

  private constructor(clave: symbol, d: Dec) {
    if (clave !== CLAVE) throw new TypeError("Constructor privado: usa Acumulado.de.");
    this.#d = d;
    Object.freeze(this);
  }

  static cero(): Acumulado {
    return new Acumulado(CLAVE, new D(0));
  }

  /** Valor de un Money real (lanza MontoInvalidoError si no lo es). */
  static de(m: Money): Acumulado {
    return new Acumulado(CLAVE, decimalDeMoney(m));
  }

  /** Una suma de NUMERIC(14,2) hecha en SQL: cadena canónica sin tope de enteros; otro valor lanza MontoInvalidoError. */
  static desdeSuma(valor: unknown): Acumulado {
    if (typeof valor !== "string" || !GRAMATICA_SUMA.test(valor)) throw new MontoInvalidoError();
    return new Acumulado(CLAVE, new D(valor));
  }

  /** `m × tc` con el redondeo SUNAT (D1), sin el tope: la conversión de `columnaUsdEnSoles` de 013 cuando no cabe. */
  static convertido(m: Money, tc: TipoCambio): Acumulado {
    return new Acumulado(CLAVE, centimosDeExacto(m.por(tc)));
  }

  /** Suma exacta (sin redondeo: ambos sumandos tienen a lo sumo 2 decimales). */
  mas(o: Acumulado): Acumulado {
    return new Acumulado(CLAVE, this.#d.plus(o.#d));
  }

  /** `true` si el valor cabe en NUMERIC(14,2). */
  cabe(): boolean {
    return this.#d.abs().lte(LIMITE);
  }

  /** Money con el valor si cabe; si no, el tope de NUMERIC(14,2) con su signo (±999999999999.99). */
  acotado(moneda: Moneda): Money {
    if (this.cabe()) return moneyDesdeDecimal(this.#d, moneda);
    return moneyDesdeDecimal(this.#d.isNegative() ? LIMITE.negated() : LIMITE, moneda);
  }
}
Object.freeze(Acumulado);
Object.freeze(Acumulado.prototype);

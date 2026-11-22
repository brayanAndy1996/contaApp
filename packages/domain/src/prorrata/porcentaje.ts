// Porcentaje de la prorrata (spec 026, R-3, U-7): cociente exacto numerador/total × 100 redondeado a
// 2 decimales mitad hacia arriba con la operación de dinero/ (sin exponer Decimal ni `number`).
// `Porcentaje` es opaco como Factor: constructor con clave de módulo, instancia y clase congeladas.
import { porcentajeDeCociente } from "../dinero/cociente";
import { Factor, Money } from "../dinero/index";
import { ProrrataError } from "./errores";

const CLAVE = Symbol("Porcentaje");
// «NN.NN» de 0.00 a 100.00 (lo único que produce porcentajeDeCociente con 0 ≤ numerador ≤ total).
const GRAMATICA_PORCENTAJE = /^(100\.00|[0-9]{1,2}\.[0-9]{2})$/;

let crearPorcentaje: (texto: string) => Porcentaje;
let leerTexto: (p: Porcentaje) => string;
let tieneEstadoPorcentaje: (o: object) => boolean;

export class Porcentaje {
  readonly #texto: string;

  private constructor(clave: symbol, texto: string) {
    if (clave !== CLAVE || !GRAMATICA_PORCENTAJE.test(texto)) {
      throw new TypeError("Constructor privado: usa porcentajeProrrata.");
    }
    this.#texto = texto;
    Object.freeze(this);
  }

  /** «NN.NN» (2 decimales; 0.00 a 100.00). */
  toString(): string {
    return this.#texto;
  }

  toJSON(): string {
    return this.#texto;
  }

  /** porcentaje / 100 como Factor exacto (87.34 → 0.8734). */
  comoFactor(): Factor {
    // «NN.NN» sin el punto son centésimas de punto (0..10000); /10000 = 1 entero y 4 decimales.
    const digitos = this.#texto.replace(".", "").padStart(5, "0");
    return Factor.desde(`${digitos.slice(0, 1)}.${digitos.slice(1)}`);
  }

  /** Solo se convierte a string: `p + 1`, `p < q` y `+p` lanzan. */
  [Symbol.toPrimitive](hint: string): string {
    if (hint === "string") return this.#texto;
    throw new TypeError("Porcentaje no se opera como número: usa sus métodos.");
  }

  static {
    crearPorcentaje = (texto) => new Porcentaje(CLAVE, texto);
    leerTexto = (p) => p.#texto;
    tieneEstadoPorcentaje = (o) => #texto in o;
  }
}
// La clase y su prototipo no se pueden parchear (como Money y Factor).
Object.freeze(Porcentaje);
Object.freeze(Porcentaje.prototype);

/** Marca privada (no `instanceof`): solo un Porcentaje creado aquí la tiene. */
export function esPorcentaje(o: unknown): o is Porcentaje {
  return typeof o === "object" && o !== null && tieneEstadoPorcentaje(o);
}

/** Centésimas de punto de un Porcentaje real (87.34 → 8734n); si no lo es, lanza. */
export function centesimasDe(p: Porcentaje): bigint {
  if (!esPorcentaje(p)) throw new ProrrataError("ENTRADA_INVALIDA");
  return BigInt(leerTexto(p).replace(".", ""));
}

/**
 * numerador / total × 100 a 2 decimales mitad hacia arriba (U-7). Solo con Money reales de la misma
 * moneda, `0 ≤ numerador ≤ total` y `total > 0`; fuera de eso lanza.
 */
export function porcentajeProrrata(numerador: Money, total: Money): Porcentaje {
  const cero = Money.cero(total.moneda);
  if (numerador.comparar(cero) < 0 || total.comparar(cero) <= 0 || numerador.comparar(total) > 0) {
    throw new ProrrataError("FUERA_DE_DOMINIO");
  }
  return crearPorcentaje(porcentajeDeCociente(numerador, total));
}

import { tokensDeGlosa } from "./normalizar";

// Spec 011, D-5 (R-GP mínima): diccionario de palabras clave por categoría.

export interface EntradaDiccionario {
  readonly categoria: string;
  readonly palabras: readonly string[];
}

export interface Coincidencia {
  readonly palabra: string;
  readonly categoria: string;
}

const MIN_LETRAS_PALABRA = 3;
const MIN_LETRAS_ABREVIATURA = 4;
const PALABRA_VALIDA = /^[a-z0-9]+$/;
const ESPACIO = /\s/u;

function normalizarPalabra(palabra: string): string {
  if (palabra.length === 0 || ESPACIO.test(palabra)) {
    throw new RangeError("Palabra de diccionario inválida: vacía o con espacios");
  }
  const tokens = tokensDeGlosa(palabra);
  const token = tokens[0];
  if (tokens.length !== 1 || token === undefined) {
    throw new RangeError("Palabra de diccionario inválida: debe ser una sola palabra");
  }
  if (!PALABRA_VALIDA.test(token) || token.length < MIN_LETRAS_PALABRA) {
    throw new RangeError("Palabra de diccionario inválida: mínimo 3 letras");
  }
  return token;
}

/** token = palabra, palabra + "s" o palabra + "es". */
function esPalabra(token: string, palabra: string): boolean {
  if (!token.startsWith(palabra)) return false;
  const resto = token.length - palabra.length;
  return resto === 0 || (resto === 1 && token.endsWith("s")) || (resto === 2 && token.endsWith("es"));
}

/**
 * Palabra completa (o su plural), con o sin punto final (T13, R1b-7: "zapatillas." al final de
 * una oración), o abreviatura con punto (>= 4 letras, prefijo de la palabra).
 */
function coincide(token: string, palabra: string): boolean {
  if (!token.endsWith(".")) return esPalabra(token, palabra);
  const sinPunto = token.slice(0, -1);
  return (
    esPalabra(sinPunto, palabra) ||
    (sinPunto.length >= MIN_LETRAS_ABREVIATURA && palabra.startsWith(sinPunto))
  );
}

export class DiccionarioGlosas {
  readonly #entradas: readonly Coincidencia[];

  private constructor(entradas: readonly Coincidencia[]) {
    this.#entradas = entradas;
    Object.freeze(this);
  }

  /** Copia y normaliza las entradas: mutar lo recibido después no afecta al diccionario. */
  static desde(entradas: readonly EntradaDiccionario[]): DiccionarioGlosas {
    const planas: Coincidencia[] = [];
    for (const entrada of entradas) {
      const categoria = entrada.categoria;
      for (const palabra of entrada.palabras) {
        planas.push(Object.freeze({ palabra: normalizarPalabra(palabra), categoria }));
      }
    }
    return new DiccionarioGlosas(Object.freeze(planas));
  }

  /** Primera glosa con coincidencia; dentro de ella, la palabra que va primero en el diccionario. */
  buscar(glosas: readonly string[]): { palabra: string; categoria: string } | null {
    for (const glosa of glosas) {
      const tokens = tokensDeGlosa(glosa);
      if (tokens.length === 0) continue;
      for (const e of this.#entradas) {
        for (const token of tokens) {
          if (coincide(token, e.palabra)) {
            return { palabra: e.palabra, categoria: e.categoria };
          }
        }
      }
    }
    return null;
  }
}

export const DICCIONARIO_GLOSAS_BASE: DiccionarioGlosas = DiccionarioGlosas.desde([
  { categoria: "calzado-ropa", palabras: ["zapatilla", "zapato", "polo", "casaca", "blusa", "vestido"] },
  { categoria: "juguetes", palabras: ["juguete", "peluche", "muñeca"] },
  { categoria: "cuidado-personal", palabras: ["perfume", "colonia", "maquillaje", "labial"] },
  { categoria: "entretenimiento", palabras: ["videojuego", "cine"] },
]);

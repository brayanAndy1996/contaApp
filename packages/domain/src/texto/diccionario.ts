import { tokensDeGlosa } from "./normalizar";

// Spec 011, D-5 (R-GP mínima): diccionario de palabras clave por categoría.
// Spec 027 (R-4, R-10): frases de excepción por palabra, índice por token (mapa exacto con plural y arreglo ordenado para las
// abreviaturas con punto) y `coincidenciasPorItem`. `buscar` conserva el comportamiento de 011.

export interface EntradaDiccionario {
  readonly categoria: string;
  readonly palabras: readonly string[];
  /**
   * 027 (R-4): hasta 5 frases de 1 a 3 palabras (normalizadas con `tokensDeGlosa`). Si una aparece seguida en un ítem, las
   * palabras de esta entrada no cuentan en ese ítem. Fuera de esos límites: RangeError.
   */
  readonly excepciones?: readonly string[];
}

export interface Coincidencia {
  readonly palabra: string;
  readonly categoria: string;
}

/** 027: una palabra del diccionario en un ítem (`item` = índice de la glosa, desde 0). */
export interface CoincidenciaItem {
  readonly item: number;
  readonly palabra: string;
  readonly categoria: string;
}

interface EntradaIndice {
  readonly palabra: string;
  readonly categoria: string;
  /** Frases de excepción como tokens sin punto final. */
  readonly excepciones: readonly (readonly string[])[];
}

const MIN_LETRAS_PALABRA = 3;
const MIN_LETRAS_ABREVIATURA = 4;
const MAX_EXCEPCIONES = 5;
const MAX_PALABRAS_FRASE = 3;
const PALABRA_VALIDA = /^[a-z0-9]+$/;
const ESPACIO = /\s/u;
const PUNTO = 46;
const S = 115;
const E = 101;

/** Normaliza una palabra del diccionario (una sola palabra [a-z0-9] de 3 o más letras); si no, RangeError. */
export function normalizarPalabra(palabra: string): string {
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

const sinPuntoFinal = (t: string): string => (t.charCodeAt(t.length - 1) === PUNTO ? t.slice(0, -1) : t);

/** Frase de excepción → sus tokens sin punto final (1 a 3); si no, RangeError. */
function normalizarFrase(frase: string): readonly string[] {
  if (typeof frase !== "string") throw new RangeError("Excepción de diccionario inválida");
  const tokens = tokensDeGlosa(frase).map(sinPuntoFinal);
  if (tokens.length === 0 || tokens.length > MAX_PALABRAS_FRASE) {
    throw new RangeError("Excepción de diccionario inválida: de 1 a 3 palabras");
  }
  return Object.freeze(tokens);
}

function normalizarExcepciones(excepciones: readonly string[] | undefined): readonly (readonly string[])[] {
  if (excepciones === undefined) return [];
  if (!Array.isArray(excepciones) || excepciones.length > MAX_EXCEPCIONES) {
    throw new RangeError("Excepciones de diccionario inválidas: hasta 5 frases");
  }
  return excepciones.map(normalizarFrase);
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

const compararTexto = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** ¿La frase aparece seguida en los tokens (sin punto final) del ítem? */
function contieneFrase(tokens: readonly string[], frase: readonly string[]): boolean {
  const ultimo = tokens.length - frase.length;
  for (let i = 0; i <= ultimo; i++) {
    let j = 0;
    while (j < frase.length && tokens[i + j] === frase[j]) j++;
    if (j === frase.length) return true;
  }
  return false;
}

/**
 * Índice determinista: una entrada por palabra. Si una palabra se repite, gana la categoría menor en orden de código y sus
 * excepciones se unen (el orden de las entradas recibidas no cambia el resultado, 027 R-2).
 */
function indexar(planas: readonly EntradaIndice[]): Map<string, EntradaIndice> {
  const indice = new Map<string, EntradaIndice>();
  for (const e of planas) {
    const previa = indice.get(e.palabra);
    if (previa === undefined || e.categoria < previa.categoria) {
      indice.set(e.palabra, e);
    } else if (e.categoria === previa.categoria && e.excepciones.length > 0) {
      const claves = new Set(previa.excepciones.map((f) => f.join(" ")));
      const union = [...previa.excepciones, ...e.excepciones.filter((f) => !claves.has(f.join(" ")))];
      union.sort((a, b) => compararTexto(a.join(" "), b.join(" ")));
      indice.set(e.palabra, { palabra: e.palabra, categoria: e.categoria, excepciones: union });
    }
  }
  return indice;
}

export class DiccionarioGlosas {
  readonly #entradas: readonly Coincidencia[];
  /** 027: palabra → entrada (exacta y plural). */
  readonly #exactas: ReadonlyMap<string, EntradaIndice>;
  /** 027: entradas por palabra en orden de código (prefijos de las abreviaturas con punto). */
  readonly #ordenadas: readonly EntradaIndice[];

  private constructor(entradas: readonly Coincidencia[], indice: Map<string, EntradaIndice>) {
    this.#entradas = entradas;
    this.#exactas = indice;
    this.#ordenadas = Object.freeze([...indice.values()].sort((a, b) => compararTexto(a.palabra, b.palabra)));
    Object.freeze(this);
  }

  /** Copia y normaliza las entradas: mutar lo recibido después no afecta al diccionario. */
  static desde(entradas: readonly EntradaDiccionario[]): DiccionarioGlosas {
    const planas: Coincidencia[] = [];
    const indexadas: EntradaIndice[] = [];
    for (const entrada of entradas) {
      const categoria = entrada.categoria;
      const excepciones = normalizarExcepciones(entrada.excepciones);
      for (const palabra of entrada.palabras) {
        const normal = normalizarPalabra(palabra);
        planas.push(Object.freeze({ palabra: normal, categoria }));
        indexadas.push({ palabra: normal, categoria, excepciones });
      }
    }
    return new DiccionarioGlosas(Object.freeze(planas), indexar(indexadas));
  }

  /** 027: ¿es una instancia real (con su campo privado)? Sin llamar a nada del objeto recibido. */
  static esInstancia(x: unknown): x is DiccionarioGlosas {
    return typeof x === "object" && x !== null && #exactas in x;
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

  /**
   * 027 (R-4): por ítem, todas las palabras que coinciden (sin las anuladas por una excepción en ese mismo ítem), en orden de
   * código; los ítems en su orden. Por índice: el costo no depende del tamaño del diccionario (R-10).
   */
  coincidenciasPorItem(glosas: readonly string[]): readonly CoincidenciaItem[] {
    const salida: CoincidenciaItem[] = [];
    const largo = glosas.length;
    for (let item = 0; item < largo; item++) {
      const tokens = tokensDeGlosa(glosas[item] as string);
      let halladas: EntradaIndice[] | null = null;
      for (const token of tokens) halladas = this.#agregarDeToken(token, halladas);
      if (halladas === null) continue;
      let sinPunto: readonly string[] | null = null;
      const vigentes: EntradaIndice[] = [];
      for (const e of halladas) {
        if (e.excepciones.length > 0) {
          sinPunto ??= tokens.map(sinPuntoFinal);
          const t = sinPunto;
          if (e.excepciones.some((f) => contieneFrase(t, f))) continue;
        }
        vigentes.push(e);
      }
      vigentes.sort((a, b) => compararTexto(a.palabra, b.palabra));
      for (const e of vigentes) salida.push(Object.freeze({ item, palabra: e.palabra, categoria: e.categoria }));
    }
    return Object.freeze(salida);
  }

  /** Entradas que coinciden con el token, agregadas sin repetir a `halladas` (que se crea con la primera). */
  #agregarDeToken(token: string, halladas: EntradaIndice[] | null): EntradaIndice[] | null {
    const conPunto = token.charCodeAt(token.length - 1) === PUNTO;
    const base = conPunto ? token.slice(0, -1) : token;
    let r = this.#agregar(this.#exactas.get(base), halladas);
    const n = base.length;
    if (n > 1 && base.charCodeAt(n - 1) === S) {
      r = this.#agregar(this.#exactas.get(base.slice(0, -1)), r);
      if (n > 2 && base.charCodeAt(n - 2) === E) r = this.#agregar(this.#exactas.get(base.slice(0, -2)), r);
    }
    if (conPunto && n >= MIN_LETRAS_ABREVIATURA) {
      const lista = this.#ordenadas;
      let bajo = 0;
      let alto = lista.length;
      while (bajo < alto) {
        const medio = (bajo + alto) >>> 1;
        if ((lista[medio] as EntradaIndice).palabra < base) bajo = medio + 1;
        else alto = medio;
      }
      for (let i = bajo; i < lista.length && (lista[i] as EntradaIndice).palabra.startsWith(base); i++) {
        r = this.#agregar(lista[i], r);
      }
    }
    return r;
  }

  #agregar(e: EntradaIndice | undefined, halladas: EntradaIndice[] | null): EntradaIndice[] | null {
    if (e === undefined) return halladas;
    if (halladas === null) return [e];
    if (!halladas.includes(e)) halladas.push(e);
    return halladas;
  }
}

export const DICCIONARIO_GLOSAS_BASE: DiccionarioGlosas = DiccionarioGlosas.desde([
  { categoria: "calzado-ropa", palabras: ["zapatilla", "zapato", "polo", "casaca", "blusa", "vestido"] },
  { categoria: "juguetes", palabras: ["juguete", "peluche", "muñeca"] },
  { categoria: "cuidado-personal", palabras: ["perfume", "colonia", "maquillaje", "labial"] },
  { categoria: "entretenimiento", palabras: ["videojuego", "cine"] },
]);

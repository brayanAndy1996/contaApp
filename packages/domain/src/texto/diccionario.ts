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

/** Entrada del índice con su posición en orden de código (para ordenar y marcar sin búsquedas lineales, H-027-2-7). */
interface EntradaOrdenada extends EntradaIndice {
  readonly orden: number;
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
const C = 99;
const H = 104;
const ADMITE_ES: ReadonlySet<number> = new Set([..."aeioulrndjsxy"].map((l) => l.charCodeAt(0)));

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

/** ¿La forma corta admite el plural en «-es»? Tras vocal (011: «audifonoes») o tras l, r, n, d, j, s, x, y o «ch» (ortografía del
 * español). Tras otra consonante no: «guantes» es «guante» + s, no «guant» + es; «lapices» no es «lapic» + es (sin raíces, H-027-1-1). */
const admitePluralEs = (corta: string): boolean => {
  const n = corta.length;
  const c = corta.charCodeAt(n - 1);
  return ADMITE_ES.has(c) || (c === H && corta.charCodeAt(n - 2) === C);
};

/**
 * 027 (H-027-1-1, decisión del usuario 2026-11-23): plural simple EN AMBOS SENTIDOS. `a` y `b` son la misma palabra si son iguales o si la
 * larga es la corta + «s» o + «es» (este último solo si la corta lo admite), con la corta de 3 letras como mínimo (el mínimo de una palabra
 * de diccionario). Sin raíces ni prefijos. La misma regla está en SQL (`gnd_misma_palabra`, 0071) para los duplicados.
 */
export function mismaPalabra(a: string, b: string): boolean {
  if (a === b) return true;
  const corta = a.length < b.length ? a : b;
  const larga = corta === a ? b : a;
  if (corta.length < MIN_LETRAS_PALABRA || !larga.startsWith(corta)) return false;
  const resto = larga.length - corta.length;
  if (resto === 1) return larga.charCodeAt(larga.length - 1) === S;
  return resto === 2 && larga.endsWith("es") && admitePluralEs(corta);
}

/**
 * Palabra completa (o su otra forma: plural o singular simple), con o sin punto final (T13, R1b-7: "zapatillas." al final de
 * una oración), o abreviatura con punto (>= 4 letras, prefijo de la palabra). Es también la regla de cada palabra de una frase
 * de excepción (R-4 «misma normalización», H-027-2-4: «SEGUR.» anula «seguridad»).
 */
function coincide(token: string, palabra: string): boolean {
  if (!token.endsWith(".")) return mismaPalabra(token, palabra);
  const sinPunto = token.slice(0, -1);
  return (
    mismaPalabra(sinPunto, palabra) ||
    (sinPunto.length >= MIN_LETRAS_ABREVIATURA && palabra.startsWith(sinPunto))
  );
}

const compararTexto = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const porOrden = (a: EntradaOrdenada, b: EntradaOrdenada): number => a.orden - b.orden;

/** Desde este número de tokens por ítem, los repetidos se saltan con un conjunto (H-027-2-7). */
const MAX_TOKENS_SIN_CONJUNTO = 16;
/** Hasta este número de entradas halladas en un ítem, una repetida se busca en la lista; con más, con la marca por posición. */
const MAX_HALLADAS_SIN_MARCA = 16;

/**
 * ¿La frase aparece seguida en los tokens del ítem? Cada token con la regla de una palabra (`coincide`): en cualquiera de sus formas
 * (H-027-1-1), con o sin punto final, o abreviado con punto (H-027-2-4).
 */
function contieneFrase(tokens: readonly string[], frase: readonly string[]): boolean {
  const ultimo = tokens.length - frase.length;
  for (let i = 0; i <= ultimo; i++) {
    let j = 0;
    while (j < frase.length && coincide(tokens[i + j] as string, frase[j] as string)) j++;
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

/**
 * Las formas de una palabra con las que coincide un token sin punto: ella misma, su plural y su singular simples. Es exactamente
 * `{x : mismaPalabra(x, palabra)}` (propiedad de `ronda2.adv.spec.ts`), así que sirve para buscar «la otra forma» en un conjunto.
 */
export function formasDePalabra(palabra: string): string[] {
  const salida = [palabra, `${palabra}s`];
  if (admitePluralEs(palabra)) salida.push(`${palabra}es`);
  const n = palabra.length;
  if (n > MIN_LETRAS_PALABRA && palabra.charCodeAt(n - 1) === S) {
    salida.push(palabra.slice(0, -1));
    const corta = palabra.slice(0, -2);
    if (palabra.charCodeAt(n - 2) === E && corta.length >= MIN_LETRAS_PALABRA && admitePluralEs(corta)) salida.push(corta);
  }
  return salida;
}

/**
 * D-8: si el diccionario trae las dos formas de una palabra (datos anteriores a 0071), es la misma palabra y gana la menor en orden
 * de código: la otra no se indexa, así que ni coincide ni aporta su categoría a S3 ni sus excepciones (H-027-2-2). El resultado va en
 * orden de código, con su posición.
 */
function sinOtrasFormas(indice: Map<string, EntradaIndice>): EntradaOrdenada[] {
  const vigentes = [...indice.values()].filter(
    (e) => !formasDePalabra(e.palabra).some((f) => f < e.palabra && indice.has(f)),
  );
  vigentes.sort((a, b) => compararTexto(a.palabra, b.palabra));
  return vigentes.map((e, orden) => Object.freeze({ ...e, orden }));
}

/** forma → entradas cuya palabra tiene esa forma (una sola consulta por token, R-10). */
function indexarFormas(ordenadas: readonly EntradaOrdenada[]): Map<string, readonly EntradaOrdenada[]> {
  const porForma = new Map<string, EntradaOrdenada[]>();
  for (const e of ordenadas) {
    for (const f of formasDePalabra(e.palabra)) {
      const lista = porForma.get(f);
      if (lista === undefined) porForma.set(f, [e]);
      else if (!lista.includes(e)) lista.push(e);
    }
  }
  return porForma;
}

export class DiccionarioGlosas {
  readonly #entradas: readonly Coincidencia[];
  /** 027: forma (la palabra, su plural o su singular simples; H-027-1-1) → entradas. */
  readonly #exactas: ReadonlyMap<string, readonly EntradaOrdenada[]>;
  /** 027: entradas por palabra en orden de código (prefijos de las abreviaturas con punto); `orden` = su índice aquí. */
  readonly #ordenadas: readonly EntradaOrdenada[];

  private constructor(entradas: readonly Coincidencia[], indice: Map<string, EntradaIndice>) {
    this.#entradas = entradas;
    const ordenadas = sinOtrasFormas(indice);
    this.#exactas = indexarFormas(ordenadas);
    this.#ordenadas = Object.freeze(ordenadas);
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
   * código; los ítems en su orden. Por índice: el costo no depende del tamaño del diccionario (R-10) y es lineal en los tokens
   * del ítem más las coincidencias (H-027-2-7: cada entrada se marca por su posición, sin buscarla entre las halladas).
   */
  coincidenciasPorItem(glosas: readonly string[]): readonly CoincidenciaItem[] {
    const salida: CoincidenciaItem[] = [];
    this.recorrerCoincidencias(glosas, (item, palabra, categoria) => {
      salida.push(Object.freeze({ item, palabra, categoria }));
    });
    return Object.freeze(salida);
  }

  /**
   * 027: las mismas coincidencias que `coincidenciasPorItem`, en el mismo orden, entregadas una a una sin crear objetos (el puntaje
   * solo cuenta ítems y elige mínimos: con miles de coincidencias por compra no se paga una asignación por cada una, H-027-2-7).
   */
  recorrerCoincidencias(glosas: readonly string[], visitar: (item: number, palabra: string, categoria: string) => void): void {
    const largo = glosas.length;
    // Entradas halladas en el ítem en curso (se reutiliza) y marca[orden] = ítem + 1 si ya está entre ellas (se crea con la primera).
    const halladas: EntradaOrdenada[] = [];
    let marca: Int32Array | null = null;
    for (let item = 0; item < largo; item++) {
      const tokens = tokensDeGlosa(glosas[item] as string);
      const sello = item + 1;
      halladas.length = 0;
      // Un token repetido daría las mismas entradas: en ítems largos se mira una vez (los cortos no lo necesitan).
      const vistos = tokens.length > MAX_TOKENS_SIN_CONJUNTO ? new Set<string>() : null;
      for (const token of tokens) {
        if (vistos !== null) {
          if (vistos.has(token)) continue;
          vistos.add(token);
        }
        marca = this.#agregarDeToken(token, sello, halladas, marca);
      }
      if (halladas.length > 1) halladas.sort(porOrden);
      for (const e of halladas) {
        if (e.excepciones.length > 0 && e.excepciones.some((f) => contieneFrase(tokens, f))) continue;
        visitar(item, e.palabra, e.categoria);
      }
    }
  }

  /**
   * Agrega a `halladas` las entradas que coinciden con el token y aún no están en ella: con pocas, se busca en `halladas`; desde
   * `MAX_HALLADAS_SIN_MARCA`, con `marca[orden] === sello` (el ítem + 1), que se crea la primera vez que hace falta (lineal).
   */
  #agregarDeToken(token: string, sello: number, halladas: EntradaOrdenada[], marca: Int32Array | null): Int32Array | null {
    const conPunto = token.charCodeAt(token.length - 1) === PUNTO;
    const base = conPunto ? token.slice(0, -1) : token;
    let m = marca;
    const conForma = this.#exactas.get(base);
    if (conForma !== undefined) for (const e of conForma) m = this.#agregar(e, sello, halladas, m);
    if (conPunto && base.length >= MIN_LETRAS_ABREVIATURA) {
      // Las palabras con ese prefijo son un tramo contiguo del orden de código: [primera ≥ base, primera ≥ base + «{») («{» sigue
      // a «z» y las palabras son [a-z0-9]), con dos búsquedas binarias.
      const lista = this.#ordenadas;
      const desde = this.#cotaInferior(base);
      const hasta = this.#cotaInferior(`${base}{`);
      if (halladas.length === 0 && hasta - desde > MAX_HALLADAS_SIN_MARCA) {
        // Ítem sin hallazgos aún (lo común con una abreviatura que casa con muchas): el tramo entra entero, marcado, sin buscar.
        m ??= new Int32Array(lista.length);
        for (let i = desde; i < hasta; i++) {
          const e = lista[i] as EntradaOrdenada;
          m[e.orden] = sello;
          halladas.push(e);
        }
      } else {
        for (let i = desde; i < hasta; i++) m = this.#agregar(lista[i] as EntradaOrdenada, sello, halladas, m);
      }
    }
    return m;
  }

  /** Posición de la primera palabra (en orden de código) que no es menor que `x`. */
  #cotaInferior(x: string): number {
    const lista = this.#ordenadas;
    let bajo = 0;
    let alto = lista.length;
    while (bajo < alto) {
      const medio = (bajo + alto) >>> 1;
      if ((lista[medio] as EntradaOrdenada).palabra < x) bajo = medio + 1;
      else alto = medio;
    }
    return bajo;
  }

  #agregar(e: EntradaOrdenada, sello: number, halladas: EntradaOrdenada[], marca: Int32Array | null): Int32Array | null {
    if (halladas.length < MAX_HALLADAS_SIN_MARCA) {
      if (!halladas.includes(e)) halladas.push(e);
      return marca;
    }
    const m = marca ?? new Int32Array(this.#ordenadas.length);
    if (m[e.orden] === sello) return m;
    // Recién se pasa a la marca en este ítem: las ya halladas se marcan una vez.
    if (halladas.length === MAX_HALLADAS_SIN_MARCA && m[(halladas[0] as EntradaOrdenada).orden] !== sello) {
      for (const h of halladas) m[h.orden] = sello;
      if (m[e.orden] === sello) return m;
    }
    m[e.orden] = sello;
    halladas.push(e);
    return m;
  }
}

export const DICCIONARIO_GLOSAS_BASE: DiccionarioGlosas = DiccionarioGlosas.desde([
  { categoria: "calzado-ropa", palabras: ["zapatilla", "zapato", "polo", "casaca", "blusa", "vestido"] },
  { categoria: "juguetes", palabras: ["juguete", "peluche", "muñeca"] },
  { categoria: "cuidado-personal", palabras: ["perfume", "colonia", "maquillaje", "labial"] },
  { categoria: "entretenimiento", palabras: ["videojuego", "cine"] },
]);

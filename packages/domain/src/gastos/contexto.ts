// Spec 027 (R-2, D-5, CA-6; plan, Contratos: domain `contexto.ts`): el contexto de la R-GP completa. El lector de `packages/db`
// lo entrega como datos planos; aquí se arma el diccionario efectivo y se valida estricto (sin claves extra, `__proto__`,
// tipos equivocados ni conteos no enteros: EntradaReglasInvalidaError). Puro: sin IO.
import { invalida, leerArreglo, leerObjeto } from "../reglas/estricto";
import type { DocProveedor } from "../reglas/tipos";
import { DiccionarioGlosas, formasDePalabra, normalizarPalabra } from "../texto/diccionario";
import type { EntradaDiccionario } from "../texto/diccionario";
import { esCategoriaGnd } from "./categorias";
import { esClaseCiiu } from "./ciiu";
import type { AjusteCategorias } from "./matriz";

/** Palabra global o propia tal como la entrega el lector (normalizada, con sus excepciones). */
export interface PalabraDiccionario {
  readonly palabra: string;
  readonly categoria: string;
  readonly excepciones: readonly string[];
  readonly activa: boolean;
}

export interface EntradaDiccionarioEfectivo {
  readonly globales: readonly PalabraDiccionario[];
  /** Palabras globales que el estudio desactivó. */
  readonly desactivadas: readonly string[];
  readonly propias: readonly PalabraDiccionario[];
}

export interface CiiuProveedor {
  readonly proveedor: DocProveedor;
  /** Clase de 4 dígitos o null («sin dato» en la caché). */
  readonly ciiu: string | null;
}

/** Conteos de U-8 por proveedor (M−6..M−1 y M−12..M−1; los periodos los resuelve el lector). */
export interface HistorialProveedor {
  readonly proveedor: DocProveedor;
  readonly aceptadas6: number;
  readonly excluidas6: number;
  readonly excluidas12: number;
}

export interface ContextoGastos {
  readonly diccionario: DiccionarioGlosas;
  /** Entero de 1 a 20 (R-11). */
  readonly umbral: number;
  readonly ciiuCliente: string | null;
  readonly ciiuProveedores: readonly CiiuProveedor[];
  readonly categoriasCliente: AjusteCategorias;
  readonly historial: readonly HistorialProveedor[];
}

/** Conteos de un proveedor (sumados si llegó en varias filas). */
export interface ConteosHistorial {
  readonly aceptadas6: number;
  readonly excluidas6: number;
  readonly excluidas12: number;
}

/** Contexto validado e indexado por la clave `tipo:NUMERO` del proveedor (la de reglas/entrada.ts). */
export interface ContextoGastosInterno {
  readonly diccionario: DiccionarioGlosas;
  readonly umbral: number;
  readonly ciiuCliente: string | null;
  readonly ciiuDe: ReadonlyMap<string, string | null>;
  readonly historialDe: ReadonlyMap<string, ConteosHistorial>;
  readonly permitidas: readonly string[];
  readonly quitadas: readonly string[];
}

const CLAVES_CONTEXTO = ["diccionario", "umbral", "ciiuCliente", "ciiuProveedores", "categoriasCliente", "historial"];
const CLAVES_CIIU = ["proveedor", "ciiu"];
const CLAVES_HISTORIAL = ["proveedor", "aceptadas6", "excluidas6", "excluidas12"];
const CLAVES_AJUSTE = ["permitidas", "quitadas"];
const CLAVES_DOC = ["tipo", "numero"];
const TIPO_DOC = /^[0-9A-Z]$/;
const NUMERO_DOC = /^[0-9A-Za-z-]{1,15}$/;
const ESPACIOS = /\s/g;
const LARGO_MAX_TEXTO_ID = 64;
const UMBRAL_MIN = 1;
const UMBRAL_MAX = 20;
const UMBRAL_011 = 3;

// ---------------------------------------------------------------- diccionario efectivo
function claveDe(palabra: unknown): string | null {
  if (typeof palabra !== "string") return null;
  try {
    return normalizarPalabra(palabra);
  } catch {
    // Una palabra desactivada fuera de gramática no corresponde a ninguna global: no desactiva nada.
    return null;
  }
}

function activa(p: PalabraDiccionario): boolean {
  if (typeof p.activa !== "boolean") throw new RangeError("Palabra de diccionario inválida: activa no es booleano");
  return p.activa;
}

const entradaDe = (p: PalabraDiccionario): EntradaDiccionario => ({
  categoria: p.categoria,
  palabras: [p.palabra],
  excepciones: p.excepciones,
});

/**
 * Global activa − desactivadas por el estudio + propias activas; una propia activa con la misma palabra que una global, o con su
 * otra forma (D-8, aclaración del usuario 2026-11-23 «ambas reemplazan», H-027-2-1), la reemplaza en ambas formas (manda su
 * categoría y sus excepciones). Una palabra o excepción inválida lanza RangeError. El orden recibido no cambia el diccionario
 * (R-2) y lo recibido no se muta.
 */
export function crearDiccionarioEfectivo(e: EntradaDiccionarioEfectivo): DiccionarioGlosas {
  const propias = e.propias.filter(activa);
  const reemplazan = new Set(propias.map((p) => normalizarPalabra(p.palabra)));
  const desactivadas = new Set(e.desactivadas.map(claveDe));
  const globales = e.globales.filter((g) => {
    if (!activa(g)) return false;
    const clave = normalizarPalabra(g.palabra);
    return !desactivadas.has(clave) && !formasDePalabra(clave).some((f) => reemplazan.has(f));
  });
  return DiccionarioGlosas.desde([...globales, ...propias].map(entradaDe));
}

// ---------------------------------------------------------------- validación estricta
function entero(x: unknown, minimo: number, maximo: number): number {
  if (typeof x !== "number" || !Number.isSafeInteger(x) || x < minimo || x > maximo) invalida();
  return x as number;
}

function ciiu(x: unknown): string | null {
  if (x === null) return null;
  if (!esClaseCiiu(x)) invalida();
  return x as string;
}

function texto(x: unknown): string {
  if (typeof x !== "string" || x.length > LARGO_MAX_TEXTO_ID) invalida();
  return x as string;
}

/** DocProveedor con la gramática de reglas/entrada.ts: número sin espacios y en mayúsculas (si no, EntradaReglasInvalidaError). */
export function normalizarDocumento(o: unknown): DocProveedor {
  const v = leerObjeto(o, CLAVES_DOC);
  const tipo = texto(v.get("tipo"));
  const numero = texto(v.get("numero")).replace(ESPACIOS, "");
  if (!TIPO_DOC.test(tipo) || !NUMERO_DOC.test(numero)) invalida();
  return Object.freeze({ tipo, numero: numero.toUpperCase() });
}

/** Clave `tipo:NUMERO` de un documento ya normalizado (la misma que `FilaInterna.proveedor.clave`). */
export const claveDocumento = (d: DocProveedor): string => `${d.tipo}:${d.numero}`;

function categorias(x: unknown): readonly string[] {
  const salida: string[] = [];
  for (const c of leerArreglo(x)) {
    if (!esCategoriaGnd(c)) invalida();
    salida.push(c as string);
  }
  return Object.freeze(salida);
}

/**
 * Valida un contexto de gastos recibido y devuelve una copia congelada (documentos normalizados). Rechaza con
 * EntradaReglasInvalidaError: claves extra o ausentes, `__proto__` propio, un diccionario que no es un `DiccionarioGlosas`
 * real, umbral fuera de 1..20 o no entero, CIIU que no es de 4 dígitos, categorías fuera de las 6 y conteos no enteros o
 * negativos. No muta la entrada.
 */
export function validarContextoGastos(x: unknown): ContextoGastos {
  const v = leerObjeto(x, CLAVES_CONTEXTO);
  const diccionario = v.get("diccionario");
  if (!DiccionarioGlosas.esInstancia(diccionario)) return invalida();
  const umbral = entero(v.get("umbral"), UMBRAL_MIN, UMBRAL_MAX);
  const ciiuCliente = ciiu(v.get("ciiuCliente"));
  const ciiuProveedores = leerArreglo(v.get("ciiuProveedores")).map((f) => {
    const fila = leerObjeto(f, CLAVES_CIIU);
    return Object.freeze({ proveedor: normalizarDocumento(fila.get("proveedor")), ciiu: ciiu(fila.get("ciiu")) });
  });
  const ajuste = leerObjeto(v.get("categoriasCliente"), CLAVES_AJUSTE);
  const categoriasCliente = Object.freeze({
    permitidas: categorias(ajuste.get("permitidas")),
    quitadas: categorias(ajuste.get("quitadas")),
  });
  const historial = leerArreglo(v.get("historial")).map((f) => {
    const fila = leerObjeto(f, CLAVES_HISTORIAL);
    return Object.freeze({
      proveedor: normalizarDocumento(fila.get("proveedor")),
      aceptadas6: entero(fila.get("aceptadas6"), 0, Number.MAX_SAFE_INTEGER),
      excluidas6: entero(fila.get("excluidas6"), 0, Number.MAX_SAFE_INTEGER),
      excluidas12: entero(fila.get("excluidas12"), 0, Number.MAX_SAFE_INTEGER),
    });
  });
  return Object.freeze({
    diccionario,
    umbral,
    ciiuCliente,
    ciiuProveedores: Object.freeze(ciiuProveedores),
    categoriasCliente,
    historial: Object.freeze(historial),
  });
}

/** El menor CIIU no nulo (determinista si un proveedor llega en varias filas). */
function unirCiiu(a: string | null | undefined, b: string | null): string | null {
  if (a === undefined || a === null) return b;
  return b !== null && b < a ? b : a;
}

/** Valida (como `validarContextoGastos`) e indexa por proveedor; el orden de las filas no cambia el resultado (R-2). */
export function contextoGastosInterno(x: unknown): ContextoGastosInterno {
  const c = validarContextoGastos(x);
  const ciiuDe = new Map<string, string | null>();
  for (const f of c.ciiuProveedores) {
    const clave = claveDocumento(f.proveedor);
    ciiuDe.set(clave, unirCiiu(ciiuDe.get(clave), f.ciiu));
  }
  const historialDe = new Map<string, ConteosHistorial>();
  for (const f of c.historial) {
    const clave = claveDocumento(f.proveedor);
    const previo = historialDe.get(clave) ?? { aceptadas6: 0, excluidas6: 0, excluidas12: 0 };
    historialDe.set(clave, {
      aceptadas6: previo.aceptadas6 + f.aceptadas6,
      excluidas6: previo.excluidas6 + f.excluidas6,
      excluidas12: previo.excluidas12 + f.excluidas12,
    });
  }
  return Object.freeze({
    diccionario: c.diccionario,
    umbral: c.umbral,
    ciiuCliente: c.ciiuCliente,
    ciiuDe,
    historialDe,
    permitidas: c.categoriasCliente.permitidas,
    quitadas: c.categoriasCliente.quitadas,
  });
}

/** Sin `ctx.gastos` (011): el diccionario del contexto, umbral 3 y sin CIIU, historial ni ajuste. */
export function contextoGastosMinimo(diccionario: DiccionarioGlosas): ContextoGastosInterno {
  return Object.freeze({
    diccionario,
    umbral: UMBRAL_011,
    ciiuCliente: null,
    ciiuDe: new Map<string, string | null>(),
    historialDe: new Map<string, ConteosHistorial>(),
    permitidas: [],
    quitadas: [],
  });
}

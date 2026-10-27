// Validación estricta de la entrada de evaluarReglas (plan 011, Decisiones: "Entrada estricta" y
// "Contexto estricto"). Lee cada propiedad una sola vez y devuelve copias internas: lo recibido no
// se muta ni se congela. Las marcas de 010 se comprueban solo con su API pública.
import { MontosComprobante } from "../comprobante/index";
import type { ColumnaCompra, Destino } from "../comprobante/index";
import { Money, TipoCambio } from "../dinero/index";
import type { Moneda } from "../dinero/index";
import { DiccionarioGlosas } from "../texto/index";
import { EntradaReglasInvalidaError } from "./errores";
import { AVISO_XML_AJENO, AVISO_XML_MONEDA } from "./explicaciones";
import type {
  Aviso,
  CodigoAviso,
  CodigoRegla,
  ContextoReglas,
  DatoRequerido,
  FilaEvaluable,
  Hallazgo,
  MontosParciales,
  OrigenUsd,
  Sugerencia,
} from "./tipos";

// ---------------------------------------------------------------- tipos internos
export interface DocNormalizado {
  readonly tipo: string;
  readonly numero: string;
  /** tipo + ":" + numero normalizado. */
  readonly clave: string;
}

export interface XmlInterno {
  readonly moneda: Moneda;
  readonly gravado: Money;
  readonly igv: Money;
  readonly noGravado: Money;
  readonly isc: Money;
  readonly icbper: Money;
  readonly total: Money;
  readonly glosas: readonly string[];
}

export interface FilaInterna {
  readonly id: string;
  readonly proveedor: DocNormalizado;
  readonly montos: MontosComprobante;
  readonly origenUsd: OrigenUsd | null;
  /** XML válido (misma identidad y moneda que la fila); si no, null. */
  readonly xml: XmlInterno | null;
  readonly aviso: Aviso | null;
}

export interface ContextoInterno {
  readonly conocidos: ReadonlySet<string>;
  readonly isc: ReadonlySet<string>;
  readonly diccionario: DiccionarioGlosas;
}

// ---------------------------------------------------------------- gramáticas
const ID_FILA = /^[A-Za-z0-9_-]{1,64}$/;
const TIPO_DOC = /^[0-9A-Z]$/;
const NUMERO_DOC = /^[0-9A-Za-z-]{1,15}$/;
const TIPO_COMPROBANTE = /^[0-9]{2}$/;
const SERIE = /^[0-9A-Z]{1,4}$/;
const DIGITOS = /^[0-9]{1,20}$/;
const NUMERO_COMPROBANTE = /^[0-9]{1,8}$/;
const ESPACIOS = /\s/g;
const CEROS_IZQUIERDA = /^0+/;
/** Cota previa a cualquier transformación de los strings de identidad recibidos. */
const LARGO_MAX_TEXTO_ID = 64;

const CLAVES_FILA = ["id", "proveedor", "comprobante", "montos", "origenUsd", "xml"];
const REQUERIDAS_FILA = ["id", "proveedor", "comprobante", "montos"];
const CLAVES_DOC = ["tipo", "numero"];
const CLAVES_COMPROBANTE = ["tipo", "serie", "numero"];
const CLAVES_ORIGEN = ["montos", "tipoCambio"];
const MONTOS_XML = ["gravado", "igv", "noGravado", "isc", "icbper", "total"];
const CLAVES_XML = ["proveedor", "comprobante", "moneda", ...MONTOS_XML, "glosas"];
const CLAVES_CONTEXTO = ["proveedoresConocidos", "proveedoresIsc", "diccionario"];

function invalida(): never {
  throw new EntradaReglasInvalidaError();
}

// ---------------------------------------------------------------- objetos estrictos
/**
 * Objeto con claves propias ⊆ `permitidas` (sin símbolos ni `__proto__` propio) y con todas las
 * `requeridas`. Devuelve un Map con cada valor leído una sola vez.
 */
export function leerObjeto(
  o: unknown,
  permitidas: readonly string[],
  requeridas: readonly string[] = permitidas,
): Map<string, unknown> {
  if (typeof o !== "object" || o === null || Array.isArray(o)) invalida();
  const obj = o as Record<string, unknown>;
  if (Object.getOwnPropertySymbols(obj).length > 0) invalida();
  const valores = new Map<string, unknown>();
  for (const k of Object.getOwnPropertyNames(obj)) {
    if (!permitidas.includes(k)) invalida();
    valores.set(k, obj[k]);
  }
  for (const k of requeridas) if (!valores.has(k)) invalida();
  return valores;
}

/** Copia de un arreglo real, por índice (sin el iterador del llamador); `undefined` en huecos. */
export function leerArreglo(a: unknown): unknown[] {
  if (!Array.isArray(a)) invalida();
  const arr = a as unknown[];
  const largo = arr.length;
  const copia: unknown[] = [];
  for (let i = 0; i < largo; i++) copia.push(arr[i]);
  return copia;
}

// ---------------------------------------------------------------- marcas de 010 y 011
const CERO_MONTOS: Readonly<Record<Moneda, MontosComprobante>> = Object.freeze({
  PEN: MontosComprobante.desde("PEN", { total: "0.00" }),
  USD: MontosComprobante.desde("USD", { total: "0.00" }),
});

export function esMoneda(m: unknown): m is Moneda {
  return m === "PEN" || m === "USD";
}

/** Money real (marca privada de 010) en `moneda`: Money.suma valida la marca y la moneda. */
export function esMoneyDe(x: unknown, moneda: Moneda): x is Money {
  try {
    Money.suma([x as Money], moneda);
    return true;
  } catch {
    // Con una instancia real estas llamadas no lanzan: cualquier error es una marca ausente.
    return false;
  }
}

/** Money real (marca privada de 010) en cualquier moneda soportada. */
export function esMoneyReal(x: unknown): x is Money {
  if (typeof x !== "object" || x === null) return false;
  const moneda: unknown = (x as { moneda?: unknown }).moneda;
  return esMoneda(moneda) && esMoneyDe(x, moneda);
}

/** MontosComprobante real (marca privada de 010): `sumar` la comprueba. */
export function esMontosReal(x: unknown): x is MontosComprobante {
  if (typeof x !== "object" || x === null) return false;
  const moneda: unknown = (x as { moneda?: unknown }).moneda;
  if (!esMoneda(moneda)) return false;
  try {
    CERO_MONTOS[moneda].sumar(x as MontosComprobante);
    return true;
  } catch {
    // Con una instancia real estas llamadas no lanzan: cualquier error es una marca ausente.
    return false;
  }
}

/** TipoCambio real: prototipo de TipoCambio (un Factor congelado no lo tiene) y marca privada. */
function esTipoCambioReal(x: unknown): x is TipoCambio {
  if (!(x instanceof TipoCambio)) return false;
  try {
    Money.cero("USD").por(x);
    return true;
  } catch {
    // Con una instancia real estas llamadas no lanzan: cualquier error es una marca ausente.
    return false;
  }
}

/** DiccionarioGlosas real: su `buscar` lee el campo privado y lanza TypeError si no lo tiene. */
function esDiccionarioReal(x: unknown): x is DiccionarioGlosas {
  if (typeof x !== "object" || x === null) return false;
  try {
    DiccionarioGlosas.prototype.buscar.call(x, ["abc"]);
    return true;
  } catch {
    // Con una instancia real estas llamadas no lanzan: cualquier error es una marca ausente.
    return false;
  }
}

// ---------------------------------------------------------------- documentos
function textoId(x: unknown): string {
  if (typeof x !== "string" || x.length > LARGO_MAX_TEXTO_ID) invalida();
  return x as string;
}

/** DocProveedor normalizado: numero sin espacios y en mayúsculas (solo ASCII antes de pasar). */
export function normalizarProveedor(o: unknown): DocNormalizado {
  const v = leerObjeto(o, CLAVES_DOC);
  const tipo = textoId(v.get("tipo"));
  const numero = textoId(v.get("numero")).replace(ESPACIOS, "");
  if (!TIPO_DOC.test(tipo) || !NUMERO_DOC.test(numero)) invalida();
  const n = numero.toUpperCase();
  return Object.freeze({ tipo, numero: n, clave: `${tipo}:${n}` });
}

/** Clave del comprobante: tipo, serie y numero sin ceros a la izquierda. */
function claveComprobante(o: unknown): string {
  const v = leerObjeto(o, CLAVES_COMPROBANTE);
  const tipo = textoId(v.get("tipo"));
  const serie = textoId(v.get("serie"));
  const digitos = textoId(v.get("numero"));
  if (!TIPO_COMPROBANTE.test(tipo) || !SERIE.test(serie) || !DIGITOS.test(digitos)) invalida();
  const numero = digitos.replace(CEROS_IZQUIERDA, "") || "0";
  if (!NUMERO_COMPROBANTE.test(numero)) invalida();
  return `${tipo}-${serie}-${numero}`;
}

// ---------------------------------------------------------------- partes de la fila
function leerOrigenUsd(o: unknown, monedaFila: Moneda): OrigenUsd {
  const v = leerObjeto(o, CLAVES_ORIGEN);
  const montos = v.get("montos");
  const tipoCambio = v.get("tipoCambio");
  if (monedaFila !== "PEN" || !esMontosReal(montos) || montos.moneda !== "USD") invalida();
  if (!esTipoCambioReal(tipoCambio)) invalida();
  return Object.freeze({ montos: montos as MontosComprobante, tipoCambio: tipoCambio as TipoCambio });
}

interface XmlLeido {
  readonly proveedor: string;
  readonly comprobante: string;
  /** Todos los montos están en `datos.moneda`. */
  readonly monedaUnica: boolean;
  readonly datos: XmlInterno;
}

function leerXml(o: unknown): XmlLeido {
  const v = leerObjeto(o, CLAVES_XML);
  const proveedor = normalizarProveedor(v.get("proveedor")).clave;
  const comprobante = claveComprobante(v.get("comprobante"));
  const moneda = v.get("moneda");
  if (!esMoneda(moneda)) return invalida();
  // Montos reales en cualquier moneda: un XML con montos en otra moneda que la fila (o mezclados)
  // no es una entrada inválida sino un XML_MONEDA.
  const montos = new Map<string, Money>();
  let monedaUnica = true;
  for (const k of MONTOS_XML) {
    const m = v.get(k);
    if (!esMoneyReal(m)) invalida();
    montos.set(k, m as Money);
    monedaUnica = monedaUnica && (m as Money).moneda === moneda;
  }
  const glosas: string[] = [];
  for (const g of leerArreglo(v.get("glosas"))) {
    if (typeof g !== "string") invalida();
    glosas.push(g as string);
  }
  const m = (k: string): Money => montos.get(k) as Money;
  return {
    proveedor,
    comprobante,
    monedaUnica,
    datos: Object.freeze({
      moneda,
      gravado: m("gravado"),
      igv: m("igv"),
      noGravado: m("noGravado"),
      isc: m("isc"),
      icbper: m("icbper"),
      total: m("total"),
      glosas: Object.freeze(glosas),
    }),
  };
}

function aviso(filaId: string, codigo: CodigoAviso, explicacion: string): Aviso {
  return Object.freeze({ filaId, codigo, explicacion });
}

function leerFila(o: unknown): FilaInterna {
  const v = leerObjeto(o, CLAVES_FILA, REQUERIDAS_FILA);
  const id = v.get("id");
  if (typeof id !== "string" || !ID_FILA.test(id)) return invalida();
  const proveedor = normalizarProveedor(v.get("proveedor"));
  const comprobante = claveComprobante(v.get("comprobante"));
  const montos = v.get("montos");
  if (!esMontosReal(montos)) return invalida();
  const origenUsd = v.has("origenUsd") ? leerOrigenUsd(v.get("origenUsd"), montos.moneda) : null;

  let xml: XmlInterno | null = null;
  let av: Aviso | null = null;
  if (v.has("xml")) {
    const leido = leerXml(v.get("xml"));
    if (leido.proveedor !== proveedor.clave || leido.comprobante !== comprobante) {
      av = aviso(id, "XML_AJENO", AVISO_XML_AJENO);
    } else if (!leido.monedaUnica || leido.datos.moneda !== montos.moneda) {
      av = aviso(id, "XML_MONEDA", AVISO_XML_MONEDA);
    } else {
      xml = leido.datos;
    }
  }
  return Object.freeze({ id, proveedor, montos, origenUsd, xml, aviso: av });
}

// ---------------------------------------------------------------- API interna
/** Filas validadas (ids únicos), en el orden recibido. */
export function validarFilas(filas: readonly FilaEvaluable[]): FilaInterna[] {
  const ids = new Set<string>();
  const salida: FilaInterna[] = [];
  for (const o of leerArreglo(filas)) {
    const f = leerFila(o);
    if (ids.has(f.id)) invalida();
    ids.add(f.id);
    salida.push(f);
  }
  return salida;
}

function clavesDe(a: unknown): ReadonlySet<string> {
  const claves = new Set<string>();
  for (const d of leerArreglo(a)) claves.add(normalizarProveedor(d).clave);
  return claves;
}

/** Contexto validado: sin claves extra, documentos válidos y diccionario real. */
export function validarContexto(ctx: ContextoReglas): ContextoInterno {
  const v = leerObjeto(ctx, CLAVES_CONTEXTO);
  const conocidos = clavesDe(v.get("proveedoresConocidos"));
  const isc = clavesDe(v.get("proveedoresIsc"));
  const diccionario = v.get("diccionario");
  if (!esDiccionarioReal(diccionario)) return invalida();
  return Object.freeze({ conocidos, isc, diccionario });
}

// ---------------------------------------------------------------- piezas internas de las reglas
export interface ParDestino {
  readonly destino: Destino;
  readonly bi: ColumnaCompra;
  readonly igv: ColumnaCompra;
}

/** Destinos en su orden de salida (DG, DGNG, DNG) con su par BI/IGV. */
export const PARES_DESTINO: readonly ParDestino[] = Object.freeze([
  Object.freeze({ destino: "DG", bi: "biDg", igv: "igvDg" }),
  Object.freeze({ destino: "DGNG", bi: "biDgng", igv: "igvDgng" }),
  Object.freeze({ destino: "DNG", bi: "biDng", igv: "igvDng" }),
] as const);

/** Hallazgo nuevo y congelado (también su sugerencia y sus lecturas). */
export function crearHallazgo(h: {
  filaId: string;
  regla: CodigoRegla;
  destino: Destino | null;
  explicacion: string;
  sugerencia: Sugerencia | null;
  requiereConfirmacion: boolean;
  dato: DatoRequerido | null;
  lecturas: MontosParciales;
}): Hallazgo {
  const sugerencia = h.sugerencia === null ? null : Object.freeze({ ...h.sugerencia });
  if (sugerencia !== null && sugerencia.tipo === "ajustar") {
    Object.freeze(sugerencia.valores);
  }
  return Object.freeze({
    filaId: h.filaId,
    regla: h.regla,
    destino: h.destino,
    explicacion: h.explicacion,
    sugerencia,
    requiereConfirmacion: h.requiereConfirmacion,
    dato: h.dato,
    lecturas: Object.freeze({ ...h.lecturas }),
  });
}

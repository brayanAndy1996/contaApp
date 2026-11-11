// Entrada estricta de prevalidar y generarTxt (plan 012, Decisiones «Errores frente a excepciones» y
// Ratificación 7, 8 y 12). Cada propiedad propia se lee exactamente una vez a una copia congelada,
// que es la que se valida y se serializa: un getter que cambia de valor o una mutación posterior no
// se cuelan. Lo recibido no se muta ni se congela.
import type { MontosComprobante } from "../comprobante/index";
import type { Money, Moneda } from "../dinero/index";
import type { CabeceraTxt, Libro } from "../formatos/tipos";
import { esMoneyReal, esMontosReal } from "../reglas/entrada";
import type { ResumenXml } from "../reglas/index";
import { COLUMNAS_VENTA } from "../ventas/columnas";
import type { ColumnaVenta } from "../ventas/columnas";
import { EntradaPrevalidacionInvalidaError } from "./errores";
import type { ErrorPrevalidacion, EstadoFila, EstadoFilaVenta } from "./tipos";

// ---------------------------------------------------------------- copias internas
export interface ComprobanteCopia {
  readonly tipo: string;
  readonly serie: string;
  readonly numero: string;
}

export interface ProveedorCopia {
  readonly tipo: string;
  readonly numero: string;
  /** `null` si no vino. */
  readonly razonSocial: string | null;
}

export interface OrigenUsdCopia {
  readonly montos: MontosComprobante;
  readonly tipoCambio: string;
}

export interface FilaCopia {
  readonly id: string;
  readonly estado: EstadoFila;
  readonly comprobante: ComprobanteCopia;
  readonly proveedor: ProveedorCopia;
  readonly fechaEmision: string;
  readonly montos: MontosComprobante;
  readonly tipoCambio: string | null;
  readonly origenUsd: OrigenUsdCopia | null;
  readonly xml: ResumenXml | null;
}

/** Copia de una fila de ventas (012b). `contraparte.tipo` es `null` en el consumidor final. */
export interface FilaVentaCopia {
  readonly id: string;
  readonly estado: EstadoFilaVenta;
  readonly comprobante: ComprobanteCopia;
  readonly contraparte: { readonly tipo: string | null; readonly numero: string };
  readonly fechaEmision: string;
  /** La de las ocho columnas (todas en la misma). */
  readonly moneda: Moneda;
  readonly montos: Readonly<Record<ColumnaVenta, Money>>;
  readonly tipoCambio: string | null;
}

/** Fila de cualquiera de los dos libros, tal como la validan y la serializan prevalidar y generarTxt. */
export type FilaTxt = FilaCopia | FilaVentaCopia;

/** Solo las copias de ventas tienen `contraparte`. */
export function esVentaCopia(f: FilaTxt): f is FilaVentaCopia {
  return "contraparte" in f;
}

/** Moneda de la fila (en compras, la de sus montos). */
export function monedaDe(f: FilaTxt): Moneda {
  return esVentaCopia(f) ? f.moneda : f.montos.moneda;
}

// ---------------------------------------------------------------- gramáticas
const ID_FILA = /^[A-Za-z0-9_-]{1,64}$/;
const PERIODO = /^[0-9]{4}(0[1-9]|1[0-2])$/;
const ESTADOS: readonly string[] = Object.freeze(["original", "modificada", "agregada", "excluida"] satisfies EstadoFila[]);
const ESTADOS_VENTA: readonly string[] = Object.freeze(["original", "agregada", "excluida"] satisfies EstadoFilaVenta[]);
const LIBROS: readonly string[] = Object.freeze(["compras", "ventas"] satisfies Libro[]);

const CLAVES_FILA = ["id", "estado", "comprobante", "proveedor", "fechaEmision", "montos", "tipoCambio", "origenUsd", "xml"];
const REQUERIDAS_FILA = ["id", "estado", "comprobante", "proveedor", "fechaEmision", "montos", "tipoCambio", "origenUsd"];
const CLAVES_COMPROBANTE = ["tipo", "serie", "numero"];
const CLAVES_PROVEEDOR = ["tipo", "numero", "razonSocial"];
const REQUERIDAS_PROVEEDOR = ["tipo", "numero"];
const CLAVES_DOC = ["tipo", "numero"];
const CLAVES_ORIGEN = ["montos", "tipoCambio"];
const MONTOS_XML = ["gravado", "igv", "noGravado", "isc", "icbper", "total"];
const CLAVES_XML = ["proveedor", "comprobante", "moneda", ...MONTOS_XML, "glosas"];
const CLAVES_CABECERA = ["rucDeclarante", "periodo", "libro"];
const CLAVES_FILA_VENTA = ["id", "estado", "comprobante", "contraparte", "fechaEmision", "montos", "tipoCambio"];
const REQUERIDAS_CONTRAPARTE = ["numero"];

export function invalida(): never {
  throw new EntradaPrevalidacionInvalidaError();
}

// ---------------------------------------------------------------- objetos estrictos
/**
 * Objeto (no arreglo) con claves propias ⊆ `permitidas`, sin símbolos ni `__proto__` propio, y con
 * todas las `requeridas`. Devuelve un Map con cada valor leído una sola vez.
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

/** Comparación por unidades de código UTF-16, sin locale. */
export function compararTexto(a: string, b: string): -1 | 0 | 1 {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * Orden de los errores: `filaId: null` primero; luego filaId, código y campo (`null` primero), por
 * unidades de código. Ids y nombres de campo nunca son "", así que `null` → "" los deja primero. Lo usan
 * prevalidar y erroresDeFilaVenta (012b), así que las dos listas salen en el mismo orden.
 */
export function compararErrores(a: ErrorPrevalidacion, b: ErrorPrevalidacion): -1 | 0 | 1 {
  return (
    compararTexto(a.filaId ?? "", b.filaId ?? "") ||
    compararTexto(a.codigo, b.codigo) ||
    compararTexto(a.campo ?? "", b.campo ?? "")
  );
}

function texto(x: unknown): string {
  return typeof x === "string" ? x : invalida();
}

function textos(v: Map<string, unknown>, claves: readonly string[]): string[] {
  return claves.map((k) => texto(v.get(k)));
}

// ---------------------------------------------------------------- partes de la fila
function leerComprobante(o: unknown): ComprobanteCopia {
  const [tipo, serie, numero] = textos(leerObjeto(o, CLAVES_COMPROBANTE), CLAVES_COMPROBANTE) as [string, string, string];
  return Object.freeze({ tipo, serie, numero });
}

function leerProveedor(o: unknown): ProveedorCopia {
  const v = leerObjeto(o, CLAVES_PROVEEDOR, REQUERIDAS_PROVEEDOR);
  const [tipo, numero] = textos(v, CLAVES_DOC) as [string, string];
  const razon = v.get("razonSocial");
  const razonSocial = razon === undefined ? null : texto(razon);
  return Object.freeze({ tipo, numero, razonSocial });
}

function leerOrigenUsd(o: unknown, monedaFila: Moneda): OrigenUsdCopia | null {
  if (o === null) return null;
  const v = leerObjeto(o, CLAVES_ORIGEN);
  const montos = v.get("montos");
  const tipoCambio = texto(v.get("tipoCambio"));
  if (monedaFila !== "PEN" || !esMontosReal(montos) || montos.moneda !== "USD") invalida();
  return Object.freeze({ montos: montos as MontosComprobante, tipoCambio });
}

function leerTipoCambio(x: unknown): string | null {
  return x === null ? null : texto(x);
}

/**
 * Copia del XML con las mismas exigencias de forma que evaluarReglas (011): así una fila que pasa
 * aquí nunca hace lanzar a las reglas por su XML, y la forma no depende de si se pasan `reglas`.
 */
function leerXml(o: unknown): ResumenXml {
  const v = leerObjeto(o, CLAVES_XML);
  const pv = leerObjeto(v.get("proveedor"), CLAVES_DOC);
  const [ptipo, pnumero] = textos(pv, CLAVES_DOC) as [string, string];
  const [tipo, serie, numero] = textos(leerObjeto(v.get("comprobante"), CLAVES_COMPROBANTE), CLAVES_COMPROBANTE) as [
    string,
    string,
    string,
  ];
  const moneda = v.get("moneda");
  if (moneda !== "PEN" && moneda !== "USD") invalida();
  const montos = new Map<string, Money>();
  for (const k of MONTOS_XML) {
    const m = v.get(k);
    if (!esMoneyReal(m)) invalida();
    montos.set(k, m as Money);
  }
  const glosas = Object.freeze(leerArreglo(v.get("glosas")).map(texto));
  const m = (k: string): Money => montos.get(k) as Money;
  return Object.freeze({
    proveedor: Object.freeze({ tipo: ptipo, numero: pnumero }),
    comprobante: Object.freeze({ tipo, serie, numero }),
    moneda: moneda as Moneda,
    gravado: m("gravado"),
    igv: m("igv"),
    noGravado: m("noGravado"),
    isc: m("isc"),
    icbper: m("icbper"),
    total: m("total"),
    glosas,
  });
}

function leerFila(o: unknown): FilaCopia {
  const v = leerObjeto(o, CLAVES_FILA, REQUERIDAS_FILA);
  const id = v.get("id");
  const estado = v.get("estado");
  if (typeof id !== "string" || !ID_FILA.test(id)) invalida();
  if (typeof estado !== "string" || !ESTADOS.includes(estado)) invalida();
  const comprobante = leerComprobante(v.get("comprobante"));
  const proveedor = leerProveedor(v.get("proveedor"));
  const fechaEmision = texto(v.get("fechaEmision"));
  const montos = v.get("montos");
  if (!esMontosReal(montos)) invalida();
  const tipoCambio = leerTipoCambio(v.get("tipoCambio"));
  const origenUsd = leerOrigenUsd(v.get("origenUsd"), montos.moneda);
  const xml = v.get("xml");
  return Object.freeze({
    id: id as string,
    estado: estado as EstadoFila,
    comprobante,
    proveedor,
    fechaEmision,
    montos,
    tipoCambio,
    origenUsd,
    xml: xml === undefined ? null : leerXml(xml),
  });
}

function leerContraparte(o: unknown): { readonly tipo: string | null; readonly numero: string } {
  const v = leerObjeto(o, CLAVES_DOC, REQUERIDAS_CONTRAPARTE);
  const tipo = v.get("tipo");
  return Object.freeze({ tipo: tipo === undefined ? null : texto(tipo), numero: texto(v.get("numero")) });
}

/** Las ocho columnas, todas Money reales y en la misma moneda. */
function leerMontosVenta(o: unknown): { moneda: Moneda; montos: Readonly<Record<ColumnaVenta, Money>> } {
  const v = leerObjeto(o, COLUMNAS_VENTA);
  const montos = {} as Record<ColumnaVenta, Money>;
  for (const c of COLUMNAS_VENTA) {
    const m = v.get(c);
    if (!esMoneyReal(m)) invalida();
    montos[c] = m;
  }
  const moneda = montos.total.moneda;
  if (COLUMNAS_VENTA.some((c) => montos[c].moneda !== moneda)) invalida();
  return { moneda, montos: Object.freeze(montos) };
}

function leerFilaVenta(o: unknown): FilaVentaCopia {
  const v = leerObjeto(o, CLAVES_FILA_VENTA);
  const id = v.get("id");
  const estado = v.get("estado");
  if (typeof id !== "string" || !ID_FILA.test(id)) invalida();
  if (typeof estado !== "string" || !ESTADOS_VENTA.includes(estado)) invalida();
  const comprobante = leerComprobante(v.get("comprobante"));
  const contraparte = leerContraparte(v.get("contraparte"));
  const fechaEmision = texto(v.get("fechaEmision"));
  const { moneda, montos } = leerMontosVenta(v.get("montos"));
  const tipoCambio = leerTipoCambio(v.get("tipoCambio"));
  return Object.freeze({
    id: id as string,
    estado: estado as EstadoFilaVenta,
    comprobante,
    contraparte,
    fechaEmision,
    moneda,
    montos,
    tipoCambio,
  });
}

// ---------------------------------------------------------------- API interna
function leerUnicas<T extends { readonly id: string }>(filas: unknown, leer: (o: unknown) => T): readonly T[] {
  const ids = new Set<string>();
  const copias: T[] = [];
  for (const o of leerArreglo(filas)) {
    const f = leer(o);
    if (ids.has(f.id)) invalida();
    ids.add(f.id);
    copias.push(f);
  }
  return Object.freeze(copias);
}

/** Filas de compras copiadas y congeladas (ids únicos), en el orden recibido. */
export function leerFilas(filas: unknown): readonly FilaCopia[] {
  return leerUnicas(filas, leerFila);
}

/** Filas de ventas copiadas y congeladas (ids únicos), en el orden recibido (012b). */
export function leerFilasVenta(filas: unknown): readonly FilaVentaCopia[] {
  return leerUnicas(filas, leerFilaVenta);
}

/** Filas del libro de la cabecera: las del otro libro son forma imposible (012b). */
export function leerFilasDe(libro: Libro, filas: unknown): readonly FilaTxt[] {
  return libro === "ventas" ? leerFilasVenta(filas) : leerFilas(filas);
}

/**
 * Cabecera con forma válida (Ratificación 7). Un `rucDeclarante` string con dígito verificador malo
 * no lanza: es el error RUC_INVALIDO de prevalidar.
 */
export function leerCabecera(o: unknown): CabeceraTxt {
  const [rucDeclarante, periodo, libro] = textos(leerObjeto(o, CLAVES_CABECERA), CLAVES_CABECERA) as [string, string, string];
  if (!PERIODO.test(periodo) || !LIBROS.includes(libro)) invalida();
  return Object.freeze({ rucDeclarante, periodo, libro: libro as Libro });
}

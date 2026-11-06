// Entrada estricta de prevalidar y generarTxt (plan 012, Decisiones «Errores frente a excepciones» y
// Ratificación 7, 8 y 12). Cada propiedad propia se lee exactamente una vez a una copia congelada,
// que es la que se valida y se serializa: un getter que cambia de valor o una mutación posterior no
// se cuelan. Lo recibido no se muta ni se congela.
import type { MontosComprobante } from "../comprobante/index";
import type { Money, Moneda } from "../dinero/index";
import type { CabeceraTxt, Libro } from "../formatos/tipos";
import { esMoneyReal, esMontosReal } from "../reglas/entrada";
import type { ResumenXml } from "../reglas/index";
import { EntradaPrevalidacionInvalidaError } from "./errores";
import type { EstadoFila } from "./tipos";

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

// ---------------------------------------------------------------- gramáticas
const ID_FILA = /^[A-Za-z0-9_-]{1,64}$/;
const PERIODO = /^[0-9]{4}(0[1-9]|1[0-2])$/;
const ESTADOS: readonly string[] = Object.freeze(["original", "modificada", "agregada", "excluida"] satisfies EstadoFila[]);
const LIBROS: readonly string[] = Object.freeze(["compras"] satisfies Libro[]);

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

// ---------------------------------------------------------------- API interna
/** Filas copiadas y congeladas (ids únicos), en el orden recibido. */
export function leerFilas(filas: unknown): readonly FilaCopia[] {
  const ids = new Set<string>();
  const copias: FilaCopia[] = [];
  for (const o of leerArreglo(filas)) {
    const f = leerFila(o);
    if (ids.has(f.id)) invalida();
    ids.add(f.id);
    copias.push(f);
  }
  return Object.freeze(copias);
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

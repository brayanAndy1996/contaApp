/**
 * Núcleo de la prueba de contrato del SIRE (spec 041, T9, CA-15). Solo pruebas: lo usan `sire.contrato.spec.ts` (manual,
 * contra SUNAT real o, con `SIRE_CONTRATO_FALSO=1`, contra el servidor falso) y `contrato-sire.spec.ts` (normal, solo
 * servidor falso).
 *
 * Reglas:
 *  - Solo el POST del token y GET; solo a los dos hosts del SIRE (o, en pruebas, a los orígenes de `urlsDePrueba`).
 *  - Lo que se devuelve y se imprime son FORMAS: conteos, códigos de catálogo, nombres de campo y de columna, estados y
 *    tiempos. Nunca valores de filas, montos, RUC, nombres, números de ticket ni tokens. Todo texto que viene de una
 *    respuesta pasa por `seguro()` (gramática cerrada) antes de entrar al informe.
 *  - Las aserciones se hacen sobre booleanos y conteos con mensaje fijo: vitest imprime el valor recibido de un `toBe`.
 *  - De TODO fallo HTTP (token, exportar, ticket, archivo, solicitud 5.51) solo se imprimen el código HTTP, las claves de
 *    primer nivel del cuerpo de error y, de él y de cada elemento de sus listas de errores (`errors`, `errores`, `detalle`…),
 *    `cod` (gramática cerrada) y `msg`/`mensaje` (acotado a 200 caracteres y con los números de 6+ dígitos tapados). Nunca
 *    el cuerpo ni ningún otro valor.
 *  - Modo diagnóstico opcional (`SIRE_CONTRATO_DIAGNOSTICO=1`): solo GET de 5.51 con variantes de `codProceso`/`codMoneda`.
 *  - Registro presentado (5.51, plan P-3, T15g): UNA sola solicitud con `codProceso` 70 y `codMoneda` PEN (obligatorio pero SIN
 *    efecto de filtro: el archivo trae todos los comprobantes, cada fila con su moneda), un ticket y un archivo. Se informa la
 *    solicitud (HTTP, `codigosSunat`, si devolvió ticket), el ticket (estados y tiempos), el archivo (ZIP, columnas, encabezado
 *    frente al de la propuesta y, si difiere, si solo es en columnas que no se mapean, filas y conteo por valor de la columna
 *    `Moneda`) y las formas de las filas. NO se verifica que `Moneda` coincida con la pedida. El `numTicket` nunca se imprime.
 *  - Archivo que el lector rechaza (`zip_invalido`): se imprime la ESTRUCTURA del ZIP (firma, EOCD, ZIP64, entradas del
 *    directorio central con el nombre sin secuencias de 4+ dígitos, método, banderas, tamaños y CRC) y el motivo deducido
 *    comparando con las reglas de `zip-seguro.ts` (`estructura-zip.ts`); nunca el contenido. Para el registro, además, una línea
 *    con la estructura de la propuesta de compras como referencia.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CredencialSire, FilaPropuestaSire, FilaVentaSire, LibroSire, TokenSire } from "../../puertos.js";
import { COD_SIN_DATOS_REGISTRO, ORIGEN_SEGURIDAD, ORIGEN_SIRE, armarUrl, origenDe, rutaRegistroPresentado } from "../endpoints.js";
import { HttpSireApiClient } from "../sire-api-client.http.js";
import { HttpSireAuth, type OpcionesHttpSire } from "../sire-auth.http.js";
import { mismoEncabezado, normalizarEncabezado } from "../txt/encabezados.js";
import { leerTxt } from "../txt/leer-txt.js";
import { mapearCompras } from "../txt/mapeo-compras.js";
import { mapearVentas } from "../txt/mapeo-ventas.js";
import { extraerTxtDeZip } from "../zip-seguro.js";
import { diagnosticarZip, lineaReferenciaPropuesta, lineasEstructura, type DiagnosticoZip, type EstructuraZip } from "./estructura-zip.js";
import { zipRaro, zipRegistroReal } from "./zip-manual.js";
import {
  CLIENT_ID,
  PERIODO,
  RUC,
  RUTAS,
  archivo,
  credencial,
  crearEntorno,
  cuerpoTicket,
  cuerpoToken,
  fixture,
  parteCompras,
  parteVentas,
  registroTicket,
  type ParteFalsa,
} from "./ayudas-http.js";

// ── Entrada y salida ────────────────────────────────────────────────────────────────────────────────────────

export interface EntradaContrato {
  credencial: CredencialSire;
  /** AAAAMM (un periodo pasado). */
  periodo: string;
  /** Solo pruebas: el servidor falso. Sin él, los hosts reales de SUNAT. */
  urlsDePrueba?: { seguridad: string; sire: string };
  /** Solo pruebas: no dormir entre consultas del ticket. */
  dormir?: (ms: number) => Promise<void>;
  /** Una línea de forma por llamada (la prueba manual la manda a `console.info`). */
  emitir?: (linea: string) => void;
  /**
   * Estructura del ZIP de la propuesta de compras por periodo: `contratoLibro` (compras) la guarda aquí y `contratoRegistro` la
   * imprime como referencia cuando el lector rechaza un archivo del registro. Un objeto compartido entre los pasos.
   */
  referenciaZip?: Record<string, EstructuraZip>;
}

export interface InformeToken {
  ms: number;
  tokenNoVacio: boolean;
  segundosDeVida: number;
  /** Nombres de campo de la respuesta del token. */
  campos: string[];
}

export interface ObsExportar {
  estado: number;
  ms: number;
  campos: string[];
}
export interface ObsTicket {
  consultas: number;
  /** Milisegundos de cada consulta (hasta las cabeceras). */
  ms: number[];
  /** `codEstadoProceso` del ticket en cada consulta; «?» si no es un código de dos dígitos. */
  estados: string[];
  camposRespuesta: string[];
  camposRegistro: string[];
  camposArchivo: string[];
  registros: number;
  partes: number;
  codTipos: string[];
}
export interface ObsArchivo {
  estado: number;
  /** Hasta recibir todo el cuerpo. */
  ms: number;
  bytes: number;
  tipoContenido: string;
  zipLegible: boolean;
  /** Estructura del ZIP y, si el lector lo rechazó, el motivo deducido (solo formas; se imprime únicamente si lo rechazó). */
  diagnostico: DiagnosticoZip;
  columnas: number;
  /** El encabezado es igual (normalizado, en el mismo orden) al del fixture de la propuesta, que es el real. */
  encabezadoCoincide: boolean;
  /**
   * Si no coincide: `solo_no_mapeadas` = el lector igualmente puede mapear ese encabezado (todas las columnas que se mapean están
   * y una vez), o sea que solo difiere un nombre de columna que no se mapea (p. ej. la 34 del registro, «ID Proyecto
   * Operadores/Partícipes»); `mapeadas` = falta o se repite una columna que sí se mapea. `ninguna` si coincide; `sin_leer` si no
   * se pudo leer el encabezado del ZIP.
   */
  diferencia: "ninguna" | "solo_no_mapeadas" | "mapeadas" | "sin_leer";
  /** Columnas del fixture que no llegaron / columnas que llegaron y el fixture no tiene (nombres, tope 20). */
  faltantes: string[];
  sobrantes: string[];
  /** Solo registro: filas de datos del TXT (0 si no es el registro o el TXT no se pudo leer). */
  filas: number;
  /** Solo registro: filas por valor de la columna `Moneda` (`PEN`, `USD` u `otra`: el valor real no se conserva). */
  filasPorMoneda: Record<string, number>;
}

/** `codProceso` único que acepta 5.51 (plan P-3). */
const COD_PROCESO_REGISTRO = "70";
/** `codMoneda` de la única solicitud 5.51: obligatorio, pero SIN efecto de filtro (el archivo trae todas las monedas). */
export const MONEDA_SOLICITUD_REGISTRO = "PEN";

/** La solicitud 5.51 (registro presentado): lo que SUNAT contestó, sin valores. */
export interface ObsSolicitudRegistro {
  /** `codProceso` pedido («?» si no es de dos dígitos). */
  codProceso: string;
  /** `codMoneda` pedido («?» si no son tres mayúsculas). */
  codMoneda: string;
  /** 2xx con `numTicket` de forma válida (el número no se conserva en el informe). */
  devolvioTicket: boolean;
  estado: number;
  ms: number;
  /** Nombres de campo de la respuesta 2xx. */
  campos: string[];
  /** Solo si SUNAT rechazó: `cod` (el de la lista de errores si la hay, si no el de primer nivel) y `msg` del error. */
  errorSunat: { cod: string; msg: string } | null;
  /** Todos los `cod` válidos del rechazo (primer nivel y lista de errores). */
  codigosSunat: string[];
}

/** `cod` y `msg` de un error de SUNAT, ya pasados por las gramáticas cerradas («?» si no las cumplen). */
export interface ItemErrorSunat {
  cod: string;
  msg: string;
}

/** Un fallo HTTP de cualquier paso, sin valores del cuerpo: solo claves de primer nivel y `cod`/`msg`. */
export interface ObsFalloHttp {
  /** Paso fijo: token, exportar, ticket, archivo, solicitud (con `codProceso`) u otro. */
  paso: string;
  estado: number;
  ms: number;
  /** El cuerpo era un objeto JSON. */
  cuerpoJson: boolean;
  /** Claves de primer nivel (nombres con gramática cerrada). */
  claves: string[];
  /** `cod`/`msg` de primer nivel, si el cuerpo trae alguno de los dos. */
  principal: ItemErrorSunat | null;
  /** Listas de errores de primer nivel (`errors`, `errores`, `detalle`…): nombre, cuántos elementos y sus `cod`/`msg` (tope 10). */
  listas: { nombre: string; total: number; items: ItemErrorSunat[] }[];
}

export interface FormaFilas {
  total: number;
  fechaInvalida: number;
  monedaInvalida: number;
  montoInvalido: number;
  tipoCambioInvalido: number;
  tipoInvalido: number;
  numeroVacio: number;
  tiposVistos: string[];
  monedasVistas: string[];
  usd: number;
  usdConTipoCambio: number;
  notasCredito: number;
  notasCreditoConTotalNegativo: number;
  notasDebito: number;
  boletas: number;
  boletasSinDocumento: number;
  /** Filas cuyo documento de la contraparte es «-» o vacío. */
  sinDocumento: number;
  filasConMontoNegativo: number;
}

/**
 * Registro presentado de compras (5.51): una solicitud, un ticket, un archivo (con sus partes). `codMoneda` no filtra, así que
 * el archivo trae filas de PEN y de USD y cada una conserva su moneda.
 */
export interface InformeRegistro {
  periodo: string;
  /** Estructura de la ZIP de la propuesta de compras del periodo (referencia comparativa); `null` si no se descargó antes. */
  referenciaPropuesta: EstructuraZip | null;
  /** Tiempo total de `descargarRegistroPresentado`. */
  ms: number;
  /** `null` si el cliente no llegó a solicitar. */
  solicitud: ObsSolicitudRegistro | null;
  /** SUNAT dijo «sin datos»: 422 (o 400) con cod 1070 al solicitar o TXT válido con solo encabezado. */
  sinDatos: boolean;
  ticket: ObsTicket;
  archivos: ObsArchivo[];
  /** Todo fallo HTTP (solicitud, ticket, archivo), en orden. */
  fallos: ObsFalloHttp[];
  /** Filas por valor de la columna `Moneda` de todos sus archivos (`PEN`, `USD`, `otra`). */
  filasPorMoneda: Record<string, number>;
  /** Forma de las filas de sus TXT (mapeadas aquí, aunque el cliente falle); `null` sin archivos o si el TXT no se pudo mapear. */
  filasArchivo: FormaFilas | null;
  /** Forma de las filas que devolvió el cliente; `null` si el cliente falló. */
  filas: FormaFilas | null;
  error: { clase: string; detalle: string } | null;
}

export interface InformeLibro {
  libro: LibroSire;
  /** Tiempo total de `descargarPropuesta`. */
  ms: number;
  exportar: ObsExportar | null;
  ticket: ObsTicket;
  archivos: ObsArchivo[];
  /** Todo fallo HTTP del libro (exportar, ticket, archivo), en orden. */
  fallos: ObsFalloHttp[];
  filas: FormaFilas | null;
  error: { clase: string; detalle: string } | null;
}

// ── Gramáticas cerradas: lo que no las cumple se imprime como «?» ───────────────────────────────────────────

const NOMBRE_CAMPO = /^[A-Za-z0-9_]{1,40}$/;
const NOMBRE_COLUMNA = /^[\p{L}\p{N} ./()_-]{1,60}$/u;
const CODIGO_ESTADO = /^\d{2}$/;
const CODIGO_TIPO_ARCHIVO = /^(\d{1,3}|null)$/;
const TIPO_MEDIA = /^[a-z0-9.+-]{1,40}\/[a-z0-9.+-]{1,40}$/;
const NOMBRE_CLASE = /^[A-Za-z]{1,40}$/;
const NOMBRE_DETALLE = /^[a-z_]{1,40}$/;
const GRAMATICA_TICKET = /^[A-Za-z0-9_-]{1,64}$/;
const CODIGO_MONEDA = /^[A-Z]{3}$/;
const TOPE_LISTA = 20;
const CODIGO_ERROR_SUNAT = /^[A-Za-z0-9_-]{1,12}$/;
const MENSAJE_ERROR_SUNAT = /^[\p{L}\p{N}\p{P}\p{Zs}]{1,200}$/u;
/** `msg` de un error de SUNAT: acotado, sin caracteres de control y con los números de 6+ dígitos tapados (podrían ser un RUC). */
function mensajeSeguro(valor: unknown): string {
  if (typeof valor !== "string") return "?";
  const recortado = valor.replace(/\d{6,}/g, "#").trim().slice(0, 200);
  return MENSAJE_ERROR_SUNAT.test(recortado) ? recortado : "?";
}

function seguro(valor: unknown, gramatica: RegExp): string {
  return typeof valor === "string" && gramatica.test(valor) ? valor : "?";
}

function esObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function campos(v: unknown): string[] {
  return esObjeto(v) ? Object.keys(v).slice(0, 40).map((k) => (/\d{6,}/.test(k) ? "?" : seguro(k, NOMBRE_CAMPO))) : [];
}

/** `cod` de un error de SUNAT: cadena o entero, con la gramática cerrada y sin números de 6+ dígitos. */
function codSeguro(valor: unknown): string {
  const v = typeof valor === "number" && Number.isSafeInteger(valor) && valor >= 0 ? String(valor) : valor;
  const cod = seguro(v, CODIGO_ERROR_SUNAT);
  return /\d{6,}/.test(cod) ? "?" : cod;
}

const CLAVES_COD = ["cod", "codigo", "code"] as const;
const CLAVES_MSG = ["msg", "mensaje", "message"] as const;
const TOPE_ITEMS_ERROR = 10;

function primerValor(o: Record<string, unknown>, claves: readonly string[]): unknown {
  for (const c of claves) if (c in o) return o[c];
  return undefined;
}

/** `cod`/`msg` de un objeto de error, o `null` si no trae ninguno de los dos campos. */
function itemDe(o: Record<string, unknown>): ItemErrorSunat | null {
  const tiene = [...CLAVES_COD, ...CLAVES_MSG].some((c) => c in o);
  if (!tiene) return null;
  return { cod: codSeguro(primerValor(o, CLAVES_COD)), msg: mensajeSeguro(primerValor(o, CLAVES_MSG)) };
}

/** Del cuerpo de un error de SUNAT solo la forma: claves de primer nivel y `cod`/`msg` (principal y de cada lista de errores). */
export function describirFallo(paso: string, estado: number, ms: number, cuerpo: unknown): ObsFalloHttp {
  const f: ObsFalloHttp = { paso, estado, ms, cuerpoJson: esObjeto(cuerpo), claves: campos(cuerpo), principal: null, listas: [] };
  if (!esObjeto(cuerpo)) return f;
  f.principal = itemDe(cuerpo);
  for (const [clave, valor] of Object.entries(cuerpo).slice(0, 40)) {
    const nombre = /\d{6,}/.test(clave) ? "?" : seguro(clave, NOMBRE_CAMPO);
    if (Array.isArray(valor)) {
      const items = (valor as unknown[])
        .slice(0, TOPE_ITEMS_ERROR)
        .map((x) => (esObjeto(x) ? itemDe(x) : null))
        .filter((x): x is ItemErrorSunat => x !== null);
      f.listas.push({ nombre, total: valor.length, items });
    } else if (esObjeto(valor)) {
      const item = itemDe(valor);
      if (item !== null) f.listas.push({ nombre, total: 1, items: [item] });
    }
  }
  return f;
}

/** `cod` y `msg` representativos de un fallo: el `cod` de la lista de errores si la hay (si no el de primer nivel) y el `msg` principal. */
function errorPrincipal(f: ObsFalloHttp): { cod: string; msg: string } {
  const delListado = f.listas.flatMap((l) => l.items).find((i) => i.cod !== "?");
  const cod = delListado?.cod ?? f.principal?.cod ?? "?";
  const msg = f.principal !== null && f.principal.msg !== "?" ? f.principal.msg : (f.listas.flatMap((l) => l.items).find((i) => i.msg !== "?")?.msg ?? "?");
  return { cod, msg };
}

function codigosDe(f: ObsFalloHttp): string[] {
  const todos = [f.principal?.cod ?? "?", ...f.listas.flatMap((l) => l.items.map((i) => i.cod))];
  return [...new Set(todos.filter((c) => c !== "?"))];
}

function pasoDeRuta(ruta: string): string {
  if (ruta.endsWith("/oauth2/token/")) return "token";
  if (ruta.endsWith("/exportacioncomprobantepropuesta") || ruta.endsWith("/exportapropuesta")) return "exportar";
  if (ruta.endsWith("/consultaestadotickets")) return "ticket";
  if (ruta.endsWith("/archivoreporte")) return "archivo";
  if (ruta.endsWith("/solicitardescarga")) return "solicitud";
  return "otro";
}

// ── Fixture de referencia: el encabezado real copiado en los TXT sintéticos ────────────────────────────────────

const DIR_FIXTURES = join(__dirname, "..", "..", "..", "..", "..", "fixtures", "sire", "http");

function celdasDeEncabezado(texto: string): string[] {
  const linea = (texto.split("\n", 1)[0] ?? "").replace(/^﻿/, "").replace(/\r$/, "");
  const celdas = linea.split("|");
  if (celdas.length > 1 && celdas[celdas.length - 1] === "") celdas.pop();
  return celdas;
}

function encabezadoDeReferencia(libro: LibroSire): string[] {
  return celdasDeEncabezado(readFileSync(join(DIR_FIXTURES, `${libro}-propuesta-202610.txt`), "utf8"));
}

/** Encabezado del único TXT del ZIP, o `null` si el ZIP no se puede leer. Solo la primera línea. */
function encabezadoDeZip(zip: Uint8Array): string[] | null {
  try {
    const txt = extraerTxtDeZip(zip);
    const fin = txt.indexOf(10);
    return celdasDeEncabezado(new TextDecoder("utf-8").decode(txt.subarray(0, fin < 0 ? txt.length : fin)));
  } catch {
    return null;
  }
}

// ── Observación de las respuestas (sin conservar ningún valor) ──────────────────────────────────────────────

/** Lo acumulado del registro presentado (una solicitud, un ticket). */
interface AcumuladoRegistro {
  solicitud: ObsSolicitudRegistro | null;
  /** Solo para reconocer nuestro ticket; jamás se imprime. */
  numTicket: string | null;
  ticket: ObsTicket;
  archivos: ObsArchivo[];
  fallos: ObsFalloHttp[];
  /** Filas mapeadas de sus TXT (en memoria, nunca se imprimen). */
  filasTxt: FilaPropuestaSire[];
  /** Algún TXT no se pudo leer o mapear. */
  txtNoMapeable: boolean;
}

/** Registro presentado: lo observado (solo cuando el paso es `contratoRegistro`). */
interface ObservacionRegistro {
  ruc: string;
  periodo: string;
  acum: AcumuladoRegistro;
}

export interface Observaciones {
  libro: LibroSire | null;
  token: { ms: number; campos: string[] } | null;
  exportar: ObsExportar | null;
  ticket: ObsTicket;
  archivos: ObsArchivo[];
  /** Todo fallo HTTP, en el orden en que ocurrió (en el registro, solo los que no se pueden atribuir a su solicitud o ticket). */
  fallos: ObsFalloHttp[];
  /** Solo para reconocer nuestro ticket; jamás se imprime. */
  numTicket: string | null;
  /** Solo en el paso del registro presentado. */
  registro: ObservacionRegistro | null;
}

function nuevoTicket(): ObsTicket {
  return {
    consultas: 0,
    ms: [],
    estados: [],
    camposRespuesta: [],
    camposRegistro: [],
    camposArchivo: [],
    registros: 0,
    partes: 0,
    codTipos: [],
  };
}

function nuevoAcumulado(): AcumuladoRegistro {
  return { solicitud: null, numTicket: null, ticket: nuevoTicket(), archivos: [], fallos: [], filasTxt: [], txtNoMapeable: false };
}

export function nuevasObservaciones(libro: LibroSire | null, registro?: { ruc: string; periodo: string }): Observaciones {
  return {
    libro,
    token: null,
    exportar: null,
    ticket: nuevoTicket(),
    archivos: [],
    fallos: [],
    numTicket: null,
    registro: registro === undefined ? null : { ...registro, acum: nuevoAcumulado() },
  };
}

async function jsonDe(r: Response): Promise<unknown> {
  try {
    return (await r.clone().json()) as unknown;
  } catch {
    return null;
  }
}

/** Filas y valores de la columna `Moneda` de un ZIP del registro; solo conteos por forma (`PEN`, `USD`, `otra`). */
function contarMonedas(bytes: Uint8Array): { filas: number; porMoneda: Record<string, number> } {
  const vacio = { filas: 0, porMoneda: {} as Record<string, number> };
  try {
    const txt = leerTxt(extraerTxtDeZip(bytes));
    const objetivo = normalizarEncabezado("Moneda");
    const i = txt.encabezado.findIndex((h) => normalizarEncabezado(h) === objetivo);
    const porMoneda: Record<string, number> = {};
    if (i >= 0) {
      for (const fila of txt.filas) {
        const v = fila[i] ?? "";
        const clave = v === "PEN" || v === "USD" ? v : "otra";
        porMoneda[clave] = (porMoneda[clave] ?? 0) + 1;
      }
    }
    return { filas: txt.filas.length, porMoneda };
  } catch {
    return vacio;
  }
}

/** Lo que cambia con 5.51: la solicitud y, por `numTicket`, el ticket y el archivo. */
async function observarRegistro(url: URL, r: Response, msCabeceras: number, t0: number, obs: Observaciones, reg: ObservacionRegistro): Promise<void> {
  const ruta = url.pathname;
  const acum = reg.acum;
  if (ruta.endsWith("/solicitardescarga")) {
    const codProceso = seguro(url.searchParams.get("codProceso"), CODIGO_ESTADO);
    const codMoneda = seguro(url.searchParams.get("codMoneda"), CODIGO_MONEDA);
    const cuerpo = await jsonDe(r);
    if (!r.ok) {
      const fallo = describirFallo(`solicitud codMoneda ${codMoneda}`, r.status, msCabeceras, cuerpo);
      acum.fallos.push(fallo);
      acum.solicitud = {
        codProceso,
        codMoneda,
        devolvioTicket: false,
        estado: r.status,
        ms: msCabeceras,
        campos: [],
        errorSunat: errorPrincipal(fallo),
        codigosSunat: codigosDe(fallo),
      };
      return;
    }
    const num = esObjeto(cuerpo) ? cuerpo["numTicket"] : undefined;
    acum.numTicket = typeof num === "string" && GRAMATICA_TICKET.test(num) ? num : null;
    acum.solicitud = {
      codProceso,
      codMoneda,
      devolvioTicket: acum.numTicket !== null,
      estado: r.status,
      ms: msCabeceras,
      campos: campos(cuerpo),
      errorSunat: null,
      codigosSunat: [],
    };
    return;
  }
  const numTicket = url.searchParams.get("numTicket");
  if (numTicket === null || numTicket !== acum.numTicket) {
    if (!r.ok) obs.fallos.push(describirFallo(pasoDeRuta(ruta), r.status, msCabeceras, await jsonDe(r)));
    return;
  }
  if (!r.ok) {
    acum.fallos.push(describirFallo(pasoDeRuta(ruta), r.status, msCabeceras, await jsonDe(r)));
    return;
  }
  if (ruta.endsWith("/consultaestadotickets")) {
    observarTicket(await jsonDe(r), msCabeceras, acum.ticket, acum.numTicket);
  } else if (ruta.endsWith("/archivoreporte")) {
    const bytes = new Uint8Array(await r.clone().arrayBuffer());
    const archivo = observarArchivo(bytes, r, Math.round(performance.now() - t0), "compras");
    const conteo = contarMonedas(bytes);
    acum.archivos.push({ ...archivo, filas: conteo.filas, filasPorMoneda: conteo.porMoneda });
    try {
      acum.filasTxt.push(...mapearCompras(leerTxt(extraerTxtDeZip(bytes)), { ruc: reg.ruc, periodo: reg.periodo }));
    } catch {
      acum.txtNoMapeable = true;
    }
  }
}

async function observar(url: URL, r: Response, msCabeceras: number, t0: number, obs: Observaciones): Promise<void> {
  const ruta = url.pathname;
  if (obs.registro !== null && (ruta.endsWith("/solicitardescarga") || ruta.endsWith("/consultaestadotickets") || ruta.endsWith("/archivoreporte"))) {
    return observarRegistro(url, r, msCabeceras, t0, obs, obs.registro);
  }
  if (!r.ok) {
    // Todo fallo HTTP: solo la forma del error (claves de primer nivel y `cod`/`msg`), nunca el cuerpo.
    obs.fallos.push(describirFallo(pasoDeRuta(ruta), r.status, msCabeceras, await jsonDe(r)));
    return;
  }
  if (ruta.endsWith("/oauth2/token/")) {
    obs.token = { ms: msCabeceras, campos: campos(await jsonDe(r)) };
  } else if (ruta.endsWith("/exportacioncomprobantepropuesta") || ruta.endsWith("/exportapropuesta")) {
    const cuerpo = await jsonDe(r);
    const num = esObjeto(cuerpo) ? cuerpo["numTicket"] : undefined;
    obs.numTicket = typeof num === "string" && GRAMATICA_TICKET.test(num) ? num : null;
    obs.exportar = { estado: r.status, ms: msCabeceras, campos: campos(cuerpo) };
  } else if (ruta.endsWith("/consultaestadotickets")) {
    observarTicket(await jsonDe(r), msCabeceras, obs.ticket, obs.numTicket);
  } else if (ruta.endsWith("/archivoreporte")) {
    const bytes = new Uint8Array(await r.clone().arrayBuffer());
    obs.archivos.push(observarArchivo(bytes, r, Math.round(performance.now() - t0), obs.libro));
  }
}

function observarTicket(cuerpo: unknown, ms: number, t: ObsTicket, numTicket: string | null): void {
  t.consultas += 1;
  t.ms.push(ms);
  t.camposRespuesta = campos(cuerpo);
  const registros = esObjeto(cuerpo) && Array.isArray(cuerpo["registros"]) ? (cuerpo["registros"] as unknown[]) : [];
  t.registros = registros.length;
  const nuestro = registros.find((x) => esObjeto(x) && x["numTicket"] === numTicket);
  if (!esObjeto(nuestro)) {
    t.estados.push("?");
    return;
  }
  t.estados.push(seguro(nuestro["codEstadoProceso"], CODIGO_ESTADO));
  t.camposRegistro = campos(nuestro);
  const partes = Array.isArray(nuestro["archivoReporte"]) ? (nuestro["archivoReporte"] as unknown[]) : [];
  t.partes = partes.length;
  const primera = partes[0];
  t.camposArchivo = campos(primera);
  t.codTipos = partes.map((p) => {
    if (!esObjeto(p)) return "?";
    const cod = p["codTipoAchivoReporte"] ?? p["codTipoArchivoReporte"];
    return cod === null || cod === undefined ? "null" : seguro(cod, CODIGO_TIPO_ARCHIVO);
  });
}

/**
 * ¿El lector podría mapear este encabezado? Se prueba con el mapeo real y CERO filas: solo valida las columnas requeridas
 * (todas presentes y una vez). Así «solo difiere una columna que no se mapea» no depende de una lista copiada aquí.
 */
function encabezadoMapeable(libro: LibroSire, encabezado: string[]): boolean {
  try {
    const txt = { encabezado, filas: [] };
    const esperado = { ruc: "", periodo: "" };
    if (libro === "compras") mapearCompras(txt, esperado);
    else mapearVentas(txt, esperado);
    return true;
  } catch {
    return false;
  }
}

function observarArchivo(bytes: Uint8Array, r: Response, ms: number, libro: LibroSire | null): ObsArchivo {
  const base = {
    estado: r.status,
    ms,
    bytes: bytes.length,
    tipoContenido: seguro((r.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase(), TIPO_MEDIA),
  };
  const diagnostico = diagnosticarZip(bytes);
  const encabezado = encabezadoDeZip(bytes);
  if (encabezado === null || libro === null) {
    return { ...base, diagnostico, zipLegible: false, columnas: 0, encabezadoCoincide: false, diferencia: "sin_leer", faltantes: [], sobrantes: [], filas: 0, filasPorMoneda: {} };
  }
  const referencia = encabezadoDeReferencia(libro);
  const recibidas = new Set(encabezado.map(normalizarEncabezado));
  const conocidas = new Set(referencia.map(normalizarEncabezado));
  const nombres = (lista: readonly string[], dentro: ReadonlySet<string>, queDebeEstar: boolean): string[] =>
    lista
      .filter((c) => dentro.has(normalizarEncabezado(c)) === queDebeEstar)
      .slice(0, TOPE_LISTA)
      .map((c) => seguro(c, NOMBRE_COLUMNA));
  const coincide = mismoEncabezado(referencia, encabezado);
  return {
    ...base,
    diagnostico,
    zipLegible: true,
    columnas: encabezado.length,
    encabezadoCoincide: coincide,
    diferencia: coincide ? "ninguna" : encabezadoMapeable(libro, encabezado) ? "solo_no_mapeadas" : "mapeadas",
    faltantes: nombres(referencia, recibidas, false),
    sobrantes: nombres(encabezado, conocidas, false),
    filas: 0,
    filasPorMoneda: {},
  };
}

// ── Fetch con guardas: solo lectura y solo a los orígenes esperados ─────────────────────────────────────────

export interface OpcionesFetchObservado {
  base: typeof fetch;
  origenesPermitidos: readonly string[];
  origenSeguridad: string;
  obs: Observaciones;
}

export function crearFetchObservado(o: OpcionesFetchObservado): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const metodo = (init?.method ?? "GET").toUpperCase();
    if (!o.origenesPermitidos.includes(url.origin)) throw new Error("contrato: origen no permitido");
    const esToken = metodo === "POST" && url.origin === o.origenSeguridad && url.pathname.endsWith("/oauth2/token/");
    if (metodo !== "GET" && !esToken) throw new Error("contrato: solo GET y el POST del token");

    const t0 = performance.now();
    const r = await o.base(input, init);
    const msCabeceras = Math.round(performance.now() - t0);
    try {
      await observar(url, r, msCabeceras, t0, o.obs);
    } catch {
      // Observar no puede cambiar el resultado de la petición.
    }
    return r;
  };
}

function opcionesHttp(e: EntradaContrato, obs: Observaciones): OpcionesHttpSire {
  const origenSeguridad = e.urlsDePrueba === undefined ? ORIGEN_SEGURIDAD : origenDe(e.urlsDePrueba.seguridad);
  const origenSire = e.urlsDePrueba === undefined ? ORIGEN_SIRE : origenDe(e.urlsDePrueba.sire);
  const o: OpcionesHttpSire = {
    fetch: crearFetchObservado({
      base: globalThis.fetch,
      origenesPermitidos: [origenSeguridad, origenSire],
      origenSeguridad,
      obs,
    }),
  };
  if (e.urlsDePrueba !== undefined) o.urlsDePrueba = e.urlsDePrueba;
  if (e.dormir !== undefined) o.dormir = e.dormir;
  return o;
}

// ── Pasos del contrato ──────────────────────────────────────────────────────────────────────────────────────

/** Paso 1: el token. */
export async function contratoToken(e: EntradaContrato): Promise<{ informe: InformeToken; token: TokenSire }> {
  const obs = nuevasObservaciones(null);
  const auth = new HttpSireAuth(opcionesHttp(e, obs));
  const t0 = performance.now();
  let token: TokenSire;
  try {
    token = await auth.obtenerToken(e.credencial);
  } catch (causa) {
    for (const f of obs.fallos) e.emitir?.(lineaFallo(`${PREFIJO} token`, f));
    throw causa;
  }
  const ms = Math.round(performance.now() - t0);
  const informe: InformeToken = {
    ms,
    tokenNoVacio: token.token.length > 0,
    segundosDeVida: Math.round((token.expiraEn.getTime() - Date.now()) / 1000),
    campos: obs.token?.campos ?? [],
  };
  e.emitir?.(lineaToken(informe));
  return { informe, token };
}

/** Pasos 2 a 4 de un libro: exportar → ticket → archivo(s) → TXT → filas. Un fallo queda en `error`, no se lanza. */
export async function contratoLibro(e: EntradaContrato, token: TokenSire, libro: LibroSire): Promise<InformeLibro> {
  const obs = nuevasObservaciones(libro);
  const cliente = new HttpSireApiClient(opcionesHttp(e, obs));
  const t0 = performance.now();
  let filas: FormaFilas | null = null;
  let error: InformeLibro["error"] = null;
  try {
    const propuesta = await cliente.descargarPropuesta(token, { ruc: e.credencial.ruc, periodo: e.periodo, libro });
    filas = analizarFilas(libro, propuesta.filas as readonly (FilaPropuestaSire | FilaVentaSire)[]);
  } catch (causa) {
    const c = esObjeto(causa) ? causa : {};
    error = { clase: seguro(c["name"], NOMBRE_CLASE), detalle: seguro(c["detalle"], NOMBRE_DETALLE) };
  }
  const informe: InformeLibro = {
    libro,
    ms: Math.round(performance.now() - t0),
    exportar: obs.exportar,
    ticket: obs.ticket,
    archivos: obs.archivos,
    fallos: obs.fallos,
    filas,
    error,
  };
  const primera = obs.archivos[0];
  if (libro === "compras" && e.referenciaZip !== undefined && primera !== undefined) e.referenciaZip[e.periodo] = primera.diagnostico.estructura;
  for (const linea of lineasLibro(e.periodo, informe)) e.emitir?.(linea);
  return informe;
}

/**
 * Paso del registro presentado de compras (5.51, P-3, T15g): el cliente real `descargarRegistroPresentado` (UNA solicitud con
 * `codProceso` 70 y `codMoneda` PEN, un ticket, un archivo). Un fallo o «sin datos» queda en el informe, no se lanza.
 */
export async function contratoRegistro(e: EntradaContrato, token: TokenSire): Promise<InformeRegistro> {
  const obs = nuevasObservaciones("compras", { ruc: e.credencial.ruc, periodo: e.periodo });
  const cliente = new HttpSireApiClient(opcionesHttp(e, obs));
  const t0 = performance.now();
  let filas: FormaFilas | null = null;
  let error: InformeRegistro["error"] = null;
  try {
    const registro = await cliente.descargarRegistroPresentado(token, { ruc: e.credencial.ruc, periodo: e.periodo });
    filas = analizarFilas("compras", registro.filas);
  } catch (causa) {
    const c = esObjeto(causa) ? causa : {};
    error = { clase: seguro(c["name"], NOMBRE_CLASE), detalle: seguro(c["detalle"], NOMBRE_DETALLE) };
  }
  const informe = informeRegistro(e.periodo, Math.round(performance.now() - t0), obs, filas, error, e.referenciaZip?.[e.periodo] ?? null);
  for (const linea of lineasRegistro(informe)) e.emitir?.(linea);
  for (const f of obs.fallos) e.emitir?.(lineaFallo(`${PREFIJO} registro-presentado ${seguro(e.periodo, /^\d{6}$/)}`, f));
  return informe;
}

/** Arma el informe con lo observado (sin el cliente: lo usan las pruebas de la observación). */
export function informeRegistro(
  periodo: string,
  ms: number,
  obs: Observaciones,
  filas: FormaFilas | null,
  error: InformeRegistro["error"],
  referenciaPropuesta: EstructuraZip | null = null,
): InformeRegistro {
  const a = obs.registro?.acum ?? nuevoAcumulado();
  const filasPorMoneda: Record<string, number> = {};
  for (const x of a.archivos) for (const [k, n] of Object.entries(x.filasPorMoneda)) filasPorMoneda[k] = (filasPorMoneda[k] ?? 0) + n;
  const s = a.solicitud;
  const rechazoSinDatos = s !== null && (s.estado === 422 || s.estado === 400) && s.codigosSunat.some((c) => COD_SIN_DATOS_REGISTRO.includes(c));
  const soloEncabezado = s?.devolvioTicket === true && a.archivos.length > 0 && a.archivos.every((x) => x.zipLegible && x.filas === 0);
  return {
    periodo,
    referenciaPropuesta,
    ms,
    solicitud: s,
    sinDatos: rechazoSinDatos || soloEncabezado,
    ticket: a.ticket,
    archivos: a.archivos,
    fallos: a.fallos,
    filasPorMoneda,
    filasArchivo: a.archivos.length > 0 && !a.txtNoMapeable ? analizarFilas("compras", a.filasTxt) : null,
    filas,
    error,
  };
}

// ── Modo diagnóstico (opcional): variantes de la solicitud 5.51 ──────────────────────────────────────────────

/** Variable que enciende el diagnóstico (además de `SIRE_CONTRATO=1`). Apagado por defecto. */
export const VARIABLE_DIAGNOSTICO = "SIRE_CONTRATO_DIAGNOSTICO";

export function diagnosticoActivo(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[VARIABLE_DIAGNOSTICO] === "1";
}

export const CODIGOS_PROCESO_DIAGNOSTICO = ["70", "01", "02", "00"] as const;
/** `null` = sin `codMoneda`. */
export const MONEDAS_DIAGNOSTICO = [null, "PEN", "USD"] as const;
const TIMEOUT_DIAGNOSTICO_MS = 10_000;

export interface ObsVariante {
  codProceso: string;
  codMoneda: "PEN" | "USD" | null;
  /** `null` si no hubo respuesta (red o timeout). */
  estado: number | null;
  ms: number;
  /** 2xx con `numTicket`: solo se informa, no se sigue el flujo del ticket. */
  devolvioTicket: boolean;
  /** Solo en 2xx: nombres de campo de la respuesta. */
  campos: string[];
  /** Solo si SUNAT rechazó. */
  fallo: ObsFalloHttp | null;
}

/**
 * Diagnóstico del 5.51 (registro presentado de compras): UN GET por variante de `codProceso` (70, 01, 02, 00) y `codMoneda`
 * (omitido, PEN, USD), en secuencia. Imprime solo HTTP, tiempo y `cod`/`msg`; si una variante devuelve `numTicket` solo lo
 * informa. Solo GET, y solo a los hosts permitidos del SIRE. No lo usa el modo normal.
 */
export async function contratoDiagnostico(e: EntradaContrato, token: TokenSire): Promise<ObsVariante[]> {
  const obs = nuevasObservaciones("compras");
  const origenSire = e.urlsDePrueba === undefined ? ORIGEN_SIRE : origenDe(e.urlsDePrueba.sire);
  const origenSeguridad = e.urlsDePrueba === undefined ? ORIGEN_SEGURIDAD : origenDe(e.urlsDePrueba.seguridad);
  const pedir = crearFetchObservado({
    base: globalThis.fetch,
    origenesPermitidos: [origenSeguridad, origenSire],
    origenSeguridad,
    obs,
  });
  const p = `${PREFIJO} diagnóstico 5.51 ${seguro(e.periodo, /^\d{6}$/)}`;
  e.emitir?.(`${p}: ${CODIGOS_PROCESO_DIAGNOSTICO.length * MONEDAS_DIAGNOSTICO.length} variantes, solo GET, en secuencia`);
  const variantes: ObsVariante[] = [];
  for (const codProceso of CODIGOS_PROCESO_DIAGNOSTICO) {
    for (const codMoneda of MONEDAS_DIAGNOSTICO) {
      const parametros: Record<string, string> = { codTipoArchivo: "0", codProceso, codOrigen: "2", lisPeriodos: e.periodo };
      if (codMoneda !== null) parametros["codMoneda"] = codMoneda;
      const url = armarUrl(origenSire, rutaRegistroPresentado(e.periodo), parametros);
      const t0 = performance.now();
      const v: ObsVariante = { codProceso, codMoneda, estado: null, ms: 0, devolvioTicket: false, campos: [], fallo: null };
      try {
        const r = await pedir(url, {
          method: "GET",
          redirect: "manual",
          headers: { authorization: `Bearer ${token.token}`, accept: "application/json" },
          signal: AbortSignal.timeout(TIMEOUT_DIAGNOSTICO_MS),
        });
        v.ms = Math.round(performance.now() - t0);
        v.estado = r.status;
        const cuerpo = await jsonDe(r);
        if (r.ok) {
          const num = esObjeto(cuerpo) ? cuerpo["numTicket"] : undefined;
          v.devolvioTicket = typeof num === "string" && GRAMATICA_TICKET.test(num);
          v.campos = campos(cuerpo);
        } else {
          v.fallo = describirFallo("solicitud", r.status, v.ms, cuerpo);
        }
      } catch {
        v.ms = Math.round(performance.now() - t0);
      }
      variantes.push(v);
      e.emitir?.(lineaVariante(p, v));
    }
  }
  return variantes;
}

export function lineaVariante(p: string, v: ObsVariante): string {
  const moneda = v.codMoneda === null ? "sin codMoneda" : `codMoneda ${v.codMoneda}`;
  const cabeza = `${p}: codProceso ${seguro(v.codProceso, CODIGO_ESTADO)} ${moneda}`;
  if (v.estado === null) return `${cabeza}: sin respuesta (red o timeout) · ${v.ms} ms`;
  if (v.fallo !== null) return `${cabeza}: HTTP ${v.estado} · ${v.ms} ms · ${textoErrores(v.fallo)}`;
  const resultado = v.devolvioTicket ? "devolvió numTicket (no se sigue el flujo)" : `sin numTicket · campos ${lista(v.campos)}`;
  return `${cabeza}: HTTP ${v.estado} · ${v.ms} ms · ${resultado}`;
}

// ── Forma de las filas ──────────────────────────────────────────────────────────────────────────────────────

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const MONTO = /^-?\d{1,12}\.\d{2}$/;
const TIPO_CAMBIO = /^\d{1,4}\.\d{1,3}$/;
const TIPO_CP = /^\d{2}$/;
const MONTOS: Readonly<Record<LibroSire, readonly string[]>> = {
  compras: ["biDg", "igvDg", "biDgng", "igvDgng", "biDng", "igvDng", "noGravado", "isc", "icbper", "otros", "total"],
  ventas: ["baseGravada", "igv", "exonerada", "inafecta", "isc", "icbper", "otros", "total"],
};

export function analizarFilas(libro: LibroSire, filas: readonly (FilaPropuestaSire | FilaVentaSire)[]): FormaFilas {
  const f: FormaFilas = {
    total: filas.length,
    fechaInvalida: 0,
    monedaInvalida: 0,
    montoInvalido: 0,
    tipoCambioInvalido: 0,
    tipoInvalido: 0,
    numeroVacio: 0,
    tiposVistos: [],
    monedasVistas: [],
    usd: 0,
    usdConTipoCambio: 0,
    notasCredito: 0,
    notasCreditoConTotalNegativo: 0,
    notasDebito: 0,
    boletas: 0,
    boletasSinDocumento: 0,
    sinDocumento: 0,
    filasConMontoNegativo: 0,
  };
  const tipos = new Set<string>();
  const monedas = new Set<string>();
  for (const fila of filas) {
    const r = fila as unknown as Record<string, unknown>;
    const texto = (campo: string): string => (typeof r[campo] === "string" ? (r[campo] as string) : "");
    const tipo = texto("tipo");
    if (!TIPO_CP.test(tipo)) f.tipoInvalido += 1;
    else tipos.add(tipo);
    if (texto("numero") === "") f.numeroVacio += 1;
    if (!FECHA.test(texto("fechaEmision"))) f.fechaInvalida += 1;

    const moneda = texto("moneda");
    if (moneda !== "PEN" && moneda !== "USD") f.monedaInvalida += 1;
    else monedas.add(moneda);
    const tc = r["tipoCambio"];
    if (moneda === "USD") {
      f.usd += 1;
      if (typeof tc === "string" && TIPO_CAMBIO.test(tc)) f.usdConTipoCambio += 1;
      else f.tipoCambioInvalido += 1;
    } else if (tc !== undefined) {
      f.tipoCambioInvalido += 1;
    }

    let negativo = false;
    for (const campo of MONTOS[libro]) {
      const m = texto(campo);
      if (!MONTO.test(m)) f.montoInvalido += 1;
      else if (m.startsWith("-") && !/^-0\.00$/.test(m)) negativo = true;
    }
    if (negativo) f.filasConMontoNegativo += 1;

    const documento = libro === "compras" ? texto("rucContraparte") : texto("docContraparte");
    const sinDocumento = documento === "-" || documento === "";
    if (sinDocumento) f.sinDocumento += 1;
    if (tipo === "07") {
      f.notasCredito += 1;
      if (texto("total").startsWith("-")) f.notasCreditoConTotalNegativo += 1;
    } else if (tipo === "08") {
      f.notasDebito += 1;
    } else if (tipo === "03") {
      f.boletas += 1;
      if (sinDocumento) f.boletasSinDocumento += 1;
    }
  }
  f.tiposVistos = [...tipos].sort();
  f.monedasVistas = [...monedas].sort();
  return f;
}

// ── Salida: solo formas y tiempos ───────────────────────────────────────────────────────────────────────────

const PREFIJO = "[contrato-sire]";
const lista = (v: readonly string[]): string => (v.length === 0 ? "-" : v.join(","));

function textoItem(i: ItemErrorSunat): string {
  return `cod ${i.cod} msg «${i.msg}»`;
}

/** Texto de los errores de un fallo: `cod`/`msg` principal y los de cada lista. Sin claves ni cuerpo. */
function textoErrores(f: ObsFalloHttp): string {
  const partes: string[] = [];
  if (f.principal !== null) partes.push(`SUNAT ${textoItem(f.principal)}`);
  for (const l of f.listas) {
    const items = l.items.length === 0 ? "sin cod/msg" : l.items.map(textoItem).join(" | ");
    partes.push(`${l.nombre}[${l.total}]: ${items}`);
  }
  return partes.length === 0 ? "sin cod/msg" : partes.join(" · ");
}

/** Línea de un fallo HTTP: código HTTP, paso, tiempo, claves de primer nivel y `cod`/`msg` (principal y de la lista de errores). */
export function lineaFallo(p: string, f: ObsFalloHttp): string {
  const cuerpo = f.cuerpoJson ? `cuerpo {${lista(f.claves)}}` : "cuerpo no JSON";
  return `${p}: FALLO HTTP ${f.estado} en ${f.paso} · ${f.ms} ms · ${cuerpo} · ${textoErrores(f)}`;
}

export function lineaToken(i: InformeToken): string {
  return `${PREFIJO} token: ${i.ms} ms · campos ${lista(i.campos)} · vida ${i.segundosDeVida} s`;
}

function lineasTicket(p: string, t: ObsTicket): string {
  return (
    `${p}: ticket ${t.consultas} consulta(s) [${t.ms.join(",")}] ms · estados ${lista(t.estados)} · ` +
    `respuesta {${lista(t.camposRespuesta)}} registros ${t.registros} · registro {${lista(t.camposRegistro)}} · ` +
    `${t.partes} archivo(s) {${lista(t.camposArchivo)}} codTipo ${lista(t.codTipos)}`
  );
}

/** Qué tipo de diferencia de encabezado hay (solo si no coincide): si solo es en columnas que el lector no mapea, no es un fallo. */
const TEXTO_DIFERENCIA: Readonly<Record<ObsArchivo["diferencia"], string>> = {
  ninguna: "",
  solo_no_mapeadas: " · la diferencia es solo de nombre en columnas que no se mapean (el lector lo acepta)",
  mapeadas: " · la diferencia afecta columnas que se mapean (el lector lo rechaza)",
  sin_leer: "",
};

/**
 * Una línea por archivo y, si el lector lo rechazó, las de su estructura (motivo, firma, EOCD, entradas). `referenciaZip`
 * (solo el registro): `undefined` = no imprimir; si no, además la línea con la estructura de la propuesta de compras.
 */
function lineasArchivos(
  p: string,
  archivos: readonly ObsArchivo[],
  referencia: string,
  conFilas = false,
  referenciaZip?: EstructuraZip | null,
): string[] {
  return archivos.flatMap((a, n) => {
    const l = [
      `${p}: archivo ${n + 1} HTTP ${a.estado} · ${a.ms} ms · ${a.bytes} bytes · ${a.tipoContenido} · zip legible ${a.zipLegible ? "sí" : "no"} · ` +
        `${a.columnas} columnas · encabezado igual al ${referencia} ${a.encabezadoCoincide ? "sí" : "no"} · ` +
        `faltan {${lista(a.faltantes)}} sobran {${lista(a.sobrantes)}}${TEXTO_DIFERENCIA[a.diferencia]}` +
        (conFilas ? ` · ${a.filas} fila(s) · columna Moneda ${textoConteo(a.filasPorMoneda)}` : ""),
    ];
    if (a.diagnostico.rechazo !== null) {
      l.push(...lineasEstructura(p, n + 1, a.diagnostico));
      if (referenciaZip !== undefined) l.push(lineaReferenciaPropuesta(p, referenciaZip));
    }
    return l;
  });
}

/** `PEN 8, USD 2` (solo formas conocidas; el resto cuenta como `otra`). */
function textoConteo(c: Readonly<Record<string, number>>): string {
  const partes = Object.entries(c).map(([k, n]) => `${seguro(k, /^(PEN|USD|otra)$/)} ${n}`);
  return partes.length === 0 ? "-" : partes.join(", ");
}

function lineasFilas(p: string, f: FormaFilas): string[] {
  return [
    `${p}: filas ${f.total} · formas inválidas fecha ${f.fechaInvalida} moneda ${f.monedaInvalida} monto ${f.montoInvalido} ` +
      `tc ${f.tipoCambioInvalido} tipo ${f.tipoInvalido} número ${f.numeroVacio} · tipos ${lista(f.tiposVistos)} · monedas ${lista(f.monedasVistas)}`,
    `${p}: P-5 · NC ${f.notasCredito} (total negativo ${f.notasCreditoConTotalNegativo}) · ND ${f.notasDebito} · USD ${f.usd} (con TC ${f.usdConTipoCambio}) · ` +
      `boletas ${f.boletas} (sin documento ${f.boletasSinDocumento}) · sin documento ${f.sinDocumento} · filas con algún monto negativo ${f.filasConMontoNegativo}`,
  ];
}

export function lineasLibro(periodo: string, i: InformeLibro): string[] {
  const p = `${PREFIJO} ${i.libro} ${seguro(periodo, /^\d{6}$/)}`;
  const l: string[] = [];
  l.push(
    `${p}: total ${i.ms} ms · exportar ${i.exportar === null ? "sin respuesta" : `${i.exportar.ms} ms, campos ${lista(i.exportar.campos)}`}`,
  );
  for (const f of i.fallos) l.push(lineaFallo(p, f));
  l.push(lineasTicket(p, i.ticket));
  l.push(...lineasArchivos(p, i.archivos, "sintético"));
  if (i.filas !== null) l.push(...lineasFilas(p, i.filas));
  if (i.error !== null) l.push(`${p}: FALLÓ ${i.error.clase} ${i.error.detalle}`);
  return l;
}

/**
 * Líneas del registro presentado (5.51): solicitud (HTTP, `codigosSunat`, si devolvió ticket), «sin datos», ticket (estados y
 * tiempos), archivos (ZIP, columnas, encabezado frente al de la propuesta, faltan/sobran, filas y conteo de la columna `Moneda`),
 * formas de las filas del TXT y, al final, lo que devolvió el cliente. No se compara `Moneda` con la pedida.
 */
export function lineasRegistro(i: InformeRegistro): string[] {
  const periodo = seguro(i.periodo, /^\d{6}$/);
  const l: string[] = [];
  const p = `${PREFIJO} registro-presentado ${periodo}`;
  const s = i.solicitud;
  if (s === null) {
    l.push(`${p}: sin solicitud (el cliente no llegó a pedirla)`);
  } else {
    const err = s.errorSunat === null ? "" : ` · SUNAT cod ${s.errorSunat.cod} msg «${s.errorSunat.msg}» · codigosSunat {${lista(s.codigosSunat)}}`;
    l.push(
      `${p}: solicitud codProceso ${s.codProceso} codMoneda ${s.codMoneda} HTTP ${s.estado} · ${s.ms} ms · campos ${lista(s.campos)} · ` +
        `devolvió ticket ${s.devolvioTicket ? "sí" : "no"}${err}`,
    );
  }
  if (i.sinDatos) l.push(`${p}: sin datos`);
  for (const f of i.fallos) l.push(lineaFallo(p, f));
  if (i.ticket.consultas > 0) l.push(lineasTicket(p, i.ticket));
  l.push(...lineasArchivos(p, i.archivos, "de la propuesta de compras", true, i.referenciaPropuesta));
  if (i.filasArchivo !== null) l.push(...lineasFilas(p, i.filasArchivo));
  else if (i.archivos.length > 0) l.push(`${p}: las filas del TXT no se pudieron mapear`);
  l.push(`${p}: total ${i.ms} ms · el cliente devolvió ${i.filas === null ? "sin filas" : `${i.filas.total} fila(s)`}`);
  if (i.error !== null) l.push(`${p}: FALLÓ ${i.error.clase} ${i.error.detalle}`);
  return l;
}

/** Suma de las formas P-5 (y de los errores de codificación, P-6) de todos los informes de todos los periodos. */
export interface TotalesP5 {
  periodos: number;
  filas: number;
  notasCredito: number;
  notasCreditoConTotalNegativo: number;
  notasDebito: number;
  usd: number;
  usdConTipoCambio: number;
  boletas: number;
  boletasSinDocumento: number;
  sinDocumento: number;
  filasConMontoNegativo: number;
  /** P-6: informes que fallaron con `codificacion` (el TXT no era UTF-8). */
  erroresCodificacion: number;
}

export function sumarTotalesP5(periodos: number, informes: readonly { filas: FormaFilas | null; error: { detalle: string } | null }[]): TotalesP5 {
  const t: TotalesP5 = {
    periodos,
    filas: 0,
    notasCredito: 0,
    notasCreditoConTotalNegativo: 0,
    notasDebito: 0,
    usd: 0,
    usdConTipoCambio: 0,
    boletas: 0,
    boletasSinDocumento: 0,
    sinDocumento: 0,
    filasConMontoNegativo: 0,
    erroresCodificacion: 0,
  };
  for (const i of informes) {
    if (i.error?.detalle === "codificacion") t.erroresCodificacion += 1;
    const f = i.filas;
    if (f === null) continue;
    t.filas += f.total;
    t.notasCredito += f.notasCredito;
    t.notasCreditoConTotalNegativo += f.notasCreditoConTotalNegativo;
    t.notasDebito += f.notasDebito;
    t.usd += f.usd;
    t.usdConTipoCambio += f.usdConTipoCambio;
    t.boletas += f.boletas;
    t.boletasSinDocumento += f.boletasSinDocumento;
    t.sinDocumento += f.sinDocumento;
    t.filasConMontoNegativo += f.filasConMontoNegativo;
  }
  return t;
}

export function lineaTotales(t: TotalesP5): string {
  return (
    `${PREFIJO} totales P-5/P-6 (${t.periodos} periodo(s), compras+ventas+registro): filas ${t.filas} · ` +
    `NC ${t.notasCredito} (total negativo ${t.notasCreditoConTotalNegativo}) · ND ${t.notasDebito} · USD ${t.usd} (con TC ${t.usdConTipoCambio}) · ` +
    `boletas ${t.boletas} (sin documento ${t.boletasSinDocumento}) · sin documento ${t.sinDocumento} · filas con algún monto negativo ${t.filasConMontoNegativo} · ` +
    `errores de codificación (P-6) ${t.erroresCodificacion}`
  );
}

// ── Credenciales de la prueba manual (nunca se imprimen) ────────────────────────────────────────────────────

export const VARIABLES_CONTRATO = [
  "SIRE_CONTRATO_CLIENT_ID",
  "SIRE_CONTRATO_CLIENT_SECRET",
  "SIRE_CONTRATO_RUC",
  "SIRE_CONTRATO_USUARIO",
  "SIRE_CONTRATO_CLAVE",
  "SIRE_CONTRATO_PERIODO",
] as const;

const MAX_PERIODOS = 12;

/** Lee las seis variables; los errores nombran la variable, jamás su valor. */
export function credencialesDelEntorno(
  env: Readonly<Record<string, string | undefined>>,
  hoy: Date = new Date(),
): { credencial: CredencialSire; periodo: string; periodos: string[] } {
  const faltan = VARIABLES_CONTRATO.filter((v) => (env[v] ?? "") === "");
  if (faltan.length > 0) throw new Error(`Faltan variables de entorno: ${faltan.join(", ")}`);
  const v = (nombre: (typeof VARIABLES_CONTRATO)[number]): string => env[nombre] ?? "";
  if (!/^\d{11}$/.test(v("SIRE_CONTRATO_RUC"))) throw new Error("SIRE_CONTRATO_RUC debe tener 11 dígitos");
  // Uno o varios periodos separados por comas (p. ej. «202510,202509,202508»); sin repetidos y en el orden dado.
  const periodos = [...new Set(v("SIRE_CONTRATO_PERIODO").split(",").map((x) => x.trim()))];
  if (periodos.length > MAX_PERIODOS) throw new Error(`SIRE_CONTRATO_PERIODO admite hasta ${MAX_PERIODOS} periodos`);
  const actual = `${hoy.getUTCFullYear()}${String(hoy.getUTCMonth() + 1).padStart(2, "0")}`;
  for (const periodo of periodos) {
    if (!/^\d{4}(0[1-9]|1[0-2])$/.test(periodo)) throw new Error("SIRE_CONTRATO_PERIODO debe ser AAAAMM (varios, separados por comas)");
    if (periodo >= actual) throw new Error("SIRE_CONTRATO_PERIODO debe ser un periodo pasado");
  }
  return {
    periodo: periodos[0] ?? "",
    periodos,
    credencial: {
      clientId: v("SIRE_CONTRATO_CLIENT_ID"),
      clientSecret: v("SIRE_CONTRATO_CLIENT_SECRET"),
      usuarioSol: v("SIRE_CONTRATO_USUARIO"),
      claveSol: v("SIRE_CONTRATO_CLAVE"),
      ruc: v("SIRE_CONTRATO_RUC"),
    },
  };
}

// ── Servidor falso para verificar la prueba de contrato sin SUNAT ───────────────────────────────────────────

export interface ServidorContratoFalso {
  entrada: EntradaContrato;
  /** Servidor `sire` (para que una prueba cambie lo que sirve). */
  sire: Awaited<ReturnType<typeof crearEntorno>>["sire"];
  cerrar(): Promise<void>;
}

/** Cuerpo de error con lista (forma de SUNAT) y datos que NUNCA deben salir en la salida: solo claves, `cod` y `msg`. */
export const CUERPO_422_FALSO = {
  cod: "422",
  msg: "Unprocessable Entity - Se presentaron errores de validación que impidieron completar el Request",
  exc: "NO-IMPRIMIR-EXC",
  errors: [
    { cod: "1138", msg: `codProceso no válido para el RUC ${RUC}`, valor: "NO-IMPRIMIR-VALOR" },
    { cod: 1139, mensaje: "Parámetro rechazado", campo: "codMoneda" },
  ],
  datos: { ruc: RUC, numTicket: "NO-IMPRIMIR-TICKET" },
} as const;
export const CUERPO_503_FALSO = {
  cod: "5000",
  msg: "Servicio no disponible",
  errores: [{ cod: "E-77", msg: "Intente luego" }],
  detalle: "NO-IMPRIMIR-DETALLE",
} as const;

/**
 * Modo «errores» del servidor falso (solo pruebas; no cambia sus API): la exportación de ventas da 503 con cuerpo de error y
 * toda solicitud 5.51 da 422 con lista de errores.
 */
export function guionarErroresFalsos(sire: ServidorContratoFalso["sire"]): void {
  sire.guionar("GET", RUTAS.exportarRvie(), { estado: 503, json: CUERPO_503_FALSO });
  sire.guionar("GET", RUTAS.solicitarRegistro(), { estado: 422, json: CUERPO_422_FALSO });
}

/** Ticket falso del registro presentado (el servidor falso lo resuelve a su ZIP). */
export const TICKET_REGISTRO_FALSO = "202610000003";
/** Fixture del archivo del registro, en `fixtures/sire/http`: 8 filas PEN y una USD, con el encabezado real (col. 34 renombrada). */
export const FIXTURE_REGISTRO_FALSO = "compras-registro-202610-mixto.txt";

/**
 * Guion de la solicitud 5.51 con el contrato real (plan P-3, corridas del usuario): solo `codProceso` 70 y `codMoneda`
 * obligatorio (cualquier moneda conocida, sin efecto de filtro). Con 70 y PEN/USD → 200 `{numTicket}` (el mismo ticket); otro
 * `codProceso` → 422 cod 1026; sin `codMoneda` → 422 cod 1061. No guiona el ticket ni el archivo.
 */
export function guionarSolicitudRegistroFalsa(sire: ServidorContratoFalso["sire"], ticket: string = TICKET_REGISTRO_FALSO): void {
  sire.guionar("GET", RUTAS.solicitarRegistro(), (p) => {
    if (p.query["codProceso"] !== COD_PROCESO_REGISTRO) {
      return { estado: 422, json: { cod: "422", msg: "Unprocessable Entity", errors: [{ cod: "1026", msg: "Código Proceso no permitido o no valido" }] } };
    }
    const moneda = p.query["codMoneda"];
    if (moneda !== "PEN" && moneda !== "USD") {
      return { estado: 422, json: { cod: "422", msg: "Unprocessable Entity", errors: [{ cod: "1061", msg: "El campo 'codMoneda' es nulo o vacio" }] } };
    }
    return { json: { numTicket: ticket } };
  });
}

/**
 * Servidor falso con los TXT sintéticos de `fixtures/sire/http`: el ticket sale «01» una vez y luego «04». Solo
 * 127.0.0.1; las credenciales son canarios sintéticos. El archivo del registro se sirve con la estructura real del ZIP (3
 * entradas: `LE#/LE#.txt` con datos, otra vacía y la carpeta). `archivosRaros`: el archivo del registro es rechazado por el
 * lector (ZIP con 2 entradas, una con ruta y con descriptor de datos), para ver el diagnóstico.
 */
export async function prepararServidorFalso(opciones: { errores?: boolean; archivosRaros?: boolean } = {}): Promise<ServidorContratoFalso> {
  const entorno = await crearEntorno();
  const compras = parteCompras();
  const ventas = parteVentas();
  const registro: ParteFalsa = {
    nombre: "20700000002-registro-202610.zip",
    zip: opciones.archivosRaros === true ? zipRaro() : zipRegistroReal("LE20700000002202610", fixture(FIXTURE_REGISTRO_FALSO)),
  };
  const tickets = new Map<string, { nombre: string; consultas: number }>([
    ["202610000001", { nombre: compras.nombre, consultas: 0 }],
    ["202610000002", { nombre: ventas.nombre, consultas: 0 }],
    [TICKET_REGISTRO_FALSO, { nombre: registro.nombre, consultas: 0 }],
  ]);
  entorno.seguridad.guionar("POST", RUTAS.token(CLIENT_ID), { json: cuerpoToken() });
  entorno.sire.guionar("GET", RUTAS.exportarRce(), { json: { numTicket: "202610000001" } });
  entorno.sire.guionar("GET", RUTAS.exportarRvie(), { json: { numTicket: "202610000002" } });
  guionarSolicitudRegistroFalsa(entorno.sire);
  entorno.sire.guionar("GET", RUTAS.ticket, (p) => {
    const t = tickets.get(p.query["numTicket"] ?? "");
    if (t === undefined) return { estado: 404 };
    t.consultas += 1;
    const estado = t.consultas === 1 ? "01" : "04";
    return {
      json: cuerpoTicket([registroTicket(p.query["numTicket"] ?? "", estado, estado === "04" ? [archivo(t.nombre)] : [])]),
    };
  });
  entorno.sire.guionar("GET", RUTAS.archivo, (p) => {
    const parte = [compras, ventas, registro].find((x) => x.nombre === p.query["nomArchivoReporte"]);
    return parte === undefined ? { estado: 404 } : { bytes: parte.zip, cabeceras: { "content-type": "application/zip" } };
  });
  if (opciones.errores === true) guionarErroresFalsos(entorno.sire);
  return {
    entrada: { credencial: credencial(), periodo: PERIODO, urlsDePrueba: entorno.urlsDePrueba },
    sire: entorno.sire,
    cerrar: () => entorno.cerrar(),
  };
}

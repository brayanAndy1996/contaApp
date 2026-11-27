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
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CredencialSire, FilaPropuestaSire, FilaVentaSire, LibroSire, TokenSire } from "../../puertos.js";
import { ORIGEN_SEGURIDAD, ORIGEN_SIRE, origenDe } from "../endpoints.js";
import { HttpSireApiClient } from "../sire-api-client.http.js";
import { HttpSireAuth, type OpcionesHttpSire } from "../sire-auth.http.js";
import { mismoEncabezado, normalizarEncabezado } from "../txt/encabezados.js";
import { extraerTxtDeZip } from "../zip-seguro.js";
import {
  CLIENT_ID,
  PERIODO,
  RUTAS,
  archivo,
  credencial,
  crearEntorno,
  cuerpoTicket,
  cuerpoToken,
  parteCompras,
  parteVentas,
  registroTicket,
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
  columnas: number;
  /** El encabezado es igual (normalizado, en el mismo orden) al del fixture sintético, que es el real. */
  encabezadoCoincide: boolean;
  /** Columnas del fixture que no llegaron / columnas que llegaron y el fixture no tiene (nombres, tope 20). */
  faltantes: string[];
  sobrantes: string[];
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

export interface InformeLibro {
  libro: LibroSire;
  /** Tiempo total de `descargarPropuesta`. */
  ms: number;
  exportar: ObsExportar | null;
  ticket: ObsTicket;
  archivos: ObsArchivo[];
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
const TOPE_LISTA = 20;

function seguro(valor: unknown, gramatica: RegExp): string {
  return typeof valor === "string" && gramatica.test(valor) ? valor : "?";
}

function esObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function campos(v: unknown): string[] {
  return esObjeto(v) ? Object.keys(v).slice(0, 40).map((k) => seguro(k, NOMBRE_CAMPO)) : [];
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

export interface Observaciones {
  libro: LibroSire | null;
  token: { ms: number; campos: string[] } | null;
  exportar: ObsExportar | null;
  ticket: ObsTicket;
  archivos: ObsArchivo[];
  /** Solo para reconocer nuestro registro; jamás se imprime. */
  numTicket: string | null;
}

export function nuevasObservaciones(libro: LibroSire | null): Observaciones {
  return {
    libro,
    token: null,
    exportar: null,
    ticket: {
      consultas: 0,
      ms: [],
      estados: [],
      camposRespuesta: [],
      camposRegistro: [],
      camposArchivo: [],
      registros: 0,
      partes: 0,
      codTipos: [],
    },
    archivos: [],
    numTicket: null,
  };
}

async function jsonDe(r: Response): Promise<unknown> {
  try {
    return (await r.clone().json()) as unknown;
  } catch {
    return null;
  }
}

async function observar(url: URL, r: Response, msCabeceras: number, t0: number, obs: Observaciones): Promise<void> {
  if (!r.ok) return;
  const ruta = url.pathname;
  if (ruta.endsWith("/oauth2/token/")) {
    obs.token = { ms: msCabeceras, campos: campos(await jsonDe(r)) };
  } else if (ruta.endsWith("/exportacioncomprobantepropuesta") || ruta.endsWith("/exportapropuesta")) {
    const cuerpo = await jsonDe(r);
    const num = esObjeto(cuerpo) ? cuerpo["numTicket"] : undefined;
    obs.numTicket = typeof num === "string" && GRAMATICA_TICKET.test(num) ? num : null;
    obs.exportar = { estado: r.status, ms: msCabeceras, campos: campos(cuerpo) };
  } else if (ruta.endsWith("/consultaestadotickets")) {
    observarTicket(await jsonDe(r), msCabeceras, obs);
  } else if (ruta.endsWith("/archivoreporte")) {
    const bytes = new Uint8Array(await r.clone().arrayBuffer());
    obs.archivos.push(observarArchivo(bytes, r, Math.round(performance.now() - t0), obs.libro));
  }
}

function observarTicket(cuerpo: unknown, ms: number, obs: Observaciones): void {
  const t = obs.ticket;
  t.consultas += 1;
  t.ms.push(ms);
  t.camposRespuesta = campos(cuerpo);
  const registros = esObjeto(cuerpo) && Array.isArray(cuerpo["registros"]) ? (cuerpo["registros"] as unknown[]) : [];
  t.registros = registros.length;
  const nuestro = registros.find((x) => esObjeto(x) && x["numTicket"] === obs.numTicket);
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

function observarArchivo(bytes: Uint8Array, r: Response, ms: number, libro: LibroSire | null): ObsArchivo {
  const base = {
    estado: r.status,
    ms,
    bytes: bytes.length,
    tipoContenido: seguro((r.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase(), TIPO_MEDIA),
  };
  const encabezado = encabezadoDeZip(bytes);
  if (encabezado === null || libro === null) {
    return { ...base, zipLegible: false, columnas: 0, encabezadoCoincide: false, faltantes: [], sobrantes: [] };
  }
  const referencia = encabezadoDeReferencia(libro);
  const recibidas = new Set(encabezado.map(normalizarEncabezado));
  const conocidas = new Set(referencia.map(normalizarEncabezado));
  const nombres = (lista: readonly string[], dentro: ReadonlySet<string>, queDebeEstar: boolean): string[] =>
    lista
      .filter((c) => dentro.has(normalizarEncabezado(c)) === queDebeEstar)
      .slice(0, TOPE_LISTA)
      .map((c) => seguro(c, NOMBRE_COLUMNA));
  return {
    ...base,
    zipLegible: true,
    columnas: encabezado.length,
    encabezadoCoincide: mismoEncabezado(referencia, encabezado),
    faltantes: nombres(referencia, recibidas, false),
    sobrantes: nombres(encabezado, conocidas, false),
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
  const token = await auth.obtenerToken(e.credencial);
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
    filas,
    error,
  };
  for (const linea of lineasLibro(e.periodo, informe)) e.emitir?.(linea);
  return informe;
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

export function lineaToken(i: InformeToken): string {
  return `${PREFIJO} token: ${i.ms} ms · campos ${lista(i.campos)} · vida ${i.segundosDeVida} s`;
}

export function lineasLibro(periodo: string, i: InformeLibro): string[] {
  const p = `${PREFIJO} ${i.libro} ${seguro(periodo, /^\d{6}$/)}`;
  const l: string[] = [];
  l.push(
    `${p}: total ${i.ms} ms · exportar ${i.exportar === null ? "sin respuesta" : `${i.exportar.ms} ms, campos ${lista(i.exportar.campos)}`}`,
  );
  const t = i.ticket;
  l.push(
    `${p}: ticket ${t.consultas} consulta(s) [${t.ms.join(",")}] ms · estados ${lista(t.estados)} · ` +
      `respuesta {${lista(t.camposRespuesta)}} registros ${t.registros} · registro {${lista(t.camposRegistro)}} · ` +
      `${t.partes} archivo(s) {${lista(t.camposArchivo)}} codTipo ${lista(t.codTipos)}`,
  );
  i.archivos.forEach((a, n) => {
    l.push(
      `${p}: archivo ${n + 1} HTTP ${a.estado} · ${a.ms} ms · ${a.bytes} bytes · ${a.tipoContenido} · zip legible ${a.zipLegible ? "sí" : "no"} · ` +
        `${a.columnas} columnas · encabezado igual al sintético ${a.encabezadoCoincide ? "sí" : "no"} · ` +
        `faltan {${lista(a.faltantes)}} sobran {${lista(a.sobrantes)}}`,
    );
  });
  if (i.filas !== null) {
    const f = i.filas;
    l.push(
      `${p}: filas ${f.total} · formas inválidas fecha ${f.fechaInvalida} moneda ${f.monedaInvalida} monto ${f.montoInvalido} ` +
        `tc ${f.tipoCambioInvalido} tipo ${f.tipoInvalido} número ${f.numeroVacio} · tipos ${lista(f.tiposVistos)} · monedas ${lista(f.monedasVistas)}`,
    );
    l.push(
      `${p}: P-5 · NC ${f.notasCredito} (total negativo ${f.notasCreditoConTotalNegativo}) · ND ${f.notasDebito} · USD ${f.usd} (con TC ${f.usdConTipoCambio}) · ` +
        `boletas ${f.boletas} (sin documento ${f.boletasSinDocumento}) · sin documento ${f.sinDocumento} · filas con algún monto negativo ${f.filasConMontoNegativo}`,
    );
  }
  if (i.error !== null) l.push(`${p}: FALLÓ ${i.error.clase} ${i.error.detalle}`);
  return l;
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

/** Lee las seis variables; los errores nombran la variable, jamás su valor. */
export function credencialesDelEntorno(
  env: Readonly<Record<string, string | undefined>>,
  hoy: Date = new Date(),
): { credencial: CredencialSire; periodo: string } {
  const faltan = VARIABLES_CONTRATO.filter((v) => (env[v] ?? "") === "");
  if (faltan.length > 0) throw new Error(`Faltan variables de entorno: ${faltan.join(", ")}`);
  const v = (nombre: (typeof VARIABLES_CONTRATO)[number]): string => env[nombre] ?? "";
  if (!/^\d{11}$/.test(v("SIRE_CONTRATO_RUC"))) throw new Error("SIRE_CONTRATO_RUC debe tener 11 dígitos");
  const periodo = v("SIRE_CONTRATO_PERIODO");
  if (!/^\d{4}(0[1-9]|1[0-2])$/.test(periodo)) throw new Error("SIRE_CONTRATO_PERIODO debe ser AAAAMM");
  const actual = `${hoy.getUTCFullYear()}${String(hoy.getUTCMonth() + 1).padStart(2, "0")}`;
  if (periodo >= actual) throw new Error("SIRE_CONTRATO_PERIODO debe ser un periodo pasado");
  return {
    periodo,
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

/**
 * Servidor falso con los TXT sintéticos de `fixtures/sire/http`: el ticket sale «01» una vez y luego «04». Solo
 * 127.0.0.1; las credenciales son canarios sintéticos.
 */
export async function prepararServidorFalso(): Promise<ServidorContratoFalso> {
  const entorno = await crearEntorno();
  const compras = parteCompras();
  const ventas = parteVentas();
  const tickets = new Map<string, { nombre: string; consultas: number }>([
    ["202610000001", { nombre: compras.nombre, consultas: 0 }],
    ["202610000002", { nombre: ventas.nombre, consultas: 0 }],
  ]);
  entorno.seguridad.guionar("POST", RUTAS.token(CLIENT_ID), { json: cuerpoToken() });
  entorno.sire.guionar("GET", RUTAS.exportarRce(), { json: { numTicket: "202610000001" } });
  entorno.sire.guionar("GET", RUTAS.exportarRvie(), { json: { numTicket: "202610000002" } });
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
    const parte = [compras, ventas].find((x) => x.nombre === p.query["nomArchivoReporte"]);
    return parte === undefined ? { estado: 404 } : { bytes: parte.zip, cabeceras: { "content-type": "application/zip" } };
  });
  return {
    entrada: { credencial: credencial(), periodo: PERIODO, urlsDePrueba: entorno.urlsDePrueba },
    sire: entorno.sire,
    cerrar: () => entorno.cerrar(),
  };
}

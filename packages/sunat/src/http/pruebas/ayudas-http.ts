/**
 * Ayudas de las pruebas del cliente HTTP del SIRE (spec 041, T3). Solo pruebas. Nada duerme ni sale a internet.
 * Reutilizables por T4 (worker): canarios, entorno de dos servidores falsos, reloj virtual y armado de ZIP/ticket.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import { zipSync } from "fflate";
import { expect } from "vitest";
import * as errores from "../../errores.js";
import type { CredencialSire } from "../../puertos.js";
import {
  iniciarServidorSireFalso,
  type GuionRespuesta,
  type ServidorSireFalso,
} from "./servidor-sire-falso.js";

// ── Canarios ────────────────────────────────────────────────────────────────────────────────────────────────
export const CANARIOS = {
  clientSecret: "CANARIO-SECRET-xyz",
  claveSol: "CANARIO-SOL-clave",
  token: "CANARIO-TOKEN-eyJhbGciOi.abc",
} as const;
export const RUC = "20700000002";
export const PERIODO = "202610";
export const CLIENT_ID = "cid-0000-1111-2222";

export function credencial(extra: Partial<CredencialSire> = {}): CredencialSire {
  return {
    clientId: CLIENT_ID,
    clientSecret: CANARIOS.clientSecret,
    usuarioSol: "USUARIOSOL",
    claveSol: CANARIOS.claveSol,
    ruc: RUC,
    ...extra,
  };
}

/** Texto sensible que no puede aparecer en ningún error (CA-12). */
export const SECRETOS: readonly string[] = [CANARIOS.clientSecret, CANARIOS.claveSol, CANARIOS.token];

// ── Errores ─────────────────────────────────────────────────────────────────────────────────────────────────
type NombreError = "TokenRechazadoError" | "ErrorDatosSire" | "ErrorPortalSire" | "ErrorTransitorioSire";
export type NombreClase =
  | NombreError
  | "ErrorCredencial"
  | "ErrorDatos"
  | "ErrorPortal"
  | "ErrorTransitorio";

/** Clase de `errores.ts`; si aún no existe lanza «no implementado» (rojo por la razón correcta). */
export function claseError(nombre: NombreClase): new (...a: never[]) => Error {
  const c = (errores as unknown as Record<string, unknown>)[nombre];
  if (typeof c !== "function") throw new Error(`no implementado: errores.${nombre}`);
  return c as new (...a: never[]) => Error;
}

/** Devuelve lo que lanza la promesa; si no lanza, falla. Un «no implementado» se relanza tal cual. */
export async function capturar(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("no implementado")) throw e;
    return e;
  }
  throw new Error("se esperaba un error y la promesa se cumplió");
}

/** Versión síncrona de `capturar`. */
export function capturarSync(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("no implementado")) throw e;
    return e;
  }
  throw new Error("se esperaba un error y la función no lanzó");
}

/** Afirma la clase (y su base `ErrorX` si es una subclase `*Sire`) y, si se pide, el `detalle` literal. */
export function esperarError(e: unknown, nombre: NombreClase, detalle?: string): void {
  const Clase = claseError(nombre);
  expect(e, `se esperaba ${nombre}`).toBeInstanceOf(Clase);
  if (nombre.endsWith("Sire")) {
    expect(e).toBeInstanceOf(claseError(nombre.replace(/Sire$/, "") as NombreClase));
  }
  if (detalle !== undefined) expect((e as { detalle?: unknown }).detalle).toBe(detalle);
}

/** CA-12: ningún secreto en `message`, `stack`, `JSON.stringify`, `inspect`, `String` ni `cause`. */
export function sinSecretos(e: unknown, secretos: readonly string[] = SECRETOS): void {
  expect(e).toBeInstanceOf(Error);
  const err = e as Error;
  const vistas = [
    err.message,
    err.stack ?? "",
    JSON.stringify(err),
    inspect(err, { depth: 8, showHidden: true }),
    String(err),
    String((err as { cause?: unknown }).cause ?? ""),
  ].join("\n");
  for (const s of secretos) expect(vistas, `el secreto ${s} aparece en el error`).not.toContain(s);
  expect((err as { cause?: unknown }).cause).toBeUndefined();
}

// ── Reloj virtual (nada duerme) ─────────────────────────────────────────────────────────────────────────────
export interface RelojVirtual {
  ahora: () => Date;
  dormir: (ms: number) => Promise<void>;
  avanzar: (ms: number) => void;
  /** Cada llamada a `dormir`, en orden. */
  esperas: number[];
  /** Suma de lo «dormido». */
  total: () => number;
}
export function relojVirtual(inicio: Date = new Date("2026-11-27T15:00:00.000Z")): RelojVirtual {
  let t = inicio.getTime();
  const esperas: number[] = [];
  return {
    ahora: () => new Date(t),
    dormir: (ms) => {
      esperas.push(ms);
      t += ms;
      return Promise.resolve();
    },
    avanzar: (ms) => {
      t += ms;
    },
    esperas,
    total: () => esperas.reduce((a, b) => a + b, 0),
  };
}

// ── Entorno: dos «hosts» falsos ─────────────────────────────────────────────────────────────────────────────
export interface EntornoFalso {
  seguridad: ServidorSireFalso;
  sire: ServidorSireFalso;
  /** Un tercero al que NADIE debe llamar (destino de redirecciones). */
  ajeno: ServidorSireFalso;
  urlsDePrueba: { seguridad: string; sire: string };
  cerrar(): Promise<void>;
}
export async function crearEntorno(): Promise<EntornoFalso> {
  const [seguridad, sire, ajeno] = await Promise.all([
    iniciarServidorSireFalso(),
    iniciarServidorSireFalso(),
    iniciarServidorSireFalso(),
  ]);
  ajeno.guionar("GET", /.*/, { texto: "no debía llegar" });
  ajeno.guionar("POST", /.*/, { texto: "no debía llegar" });
  return {
    seguridad,
    sire,
    ajeno,
    urlsDePrueba: { seguridad: seguridad.origen, sire: sire.origen },
    cerrar: async () => {
      await Promise.all([seguridad.cerrar(), sire.cerrar(), ajeno.cerrar()]);
    },
  };
}

// ── Rutas del SIRE (plan 041, Endpoints) ────────────────────────────────────────────────────────────────────
const BASE = "/v1/contribuyente/migeigv/libros";
export const RUTAS = {
  token: (clientId: string = CLIENT_ID) => `/v1/clientessol/${clientId}/oauth2/token/`,
  exportarRce: (per: string = PERIODO) => `${BASE}/rce/propuesta/web/propuesta/${per}/exportacioncomprobantepropuesta`,
  exportarRvie: (per: string = PERIODO) => `${BASE}/rvie/propuesta/web/propuesta/${per}/exportapropuesta`,
  ticket: `${BASE}/rvierce/gestionprocesosmasivos/web/masivo/consultaestadotickets`,
  archivo: `${BASE}/rvierce/gestionprocesosmasivos/web/masivo/archivoreporte`,
} as const;
export const URL_REAL = {
  seguridad: "https://api-seguridad.sunat.gob.pe",
  sire: "https://api-sire.sunat.gob.pe",
} as const;

// ── Cuerpos de SUNAT ────────────────────────────────────────────────────────────────────────────────────────
export function cuerpoToken(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { access_token: CANARIOS.token, token_type: "JWT", expires_in: 3600, ...extra };
}

export interface ArchivoTicket {
  nomArchivoReporte: string;
  /** El portal escribe `codTipoAchivoReporte` (sin «r»); algunas versiones, `codTipoArchivoReporte`. */
  codTipoAchivoReporte?: string | null;
  codTipoArchivoReporte?: string | null;
}
export function archivo(nombre: string, cod: string | null = "00"): ArchivoTicket {
  return { nomArchivoReporte: nombre, codTipoAchivoReporte: cod };
}
export function registroTicket(
  numTicket: string,
  estado: string,
  archivos: ArchivoTicket[] = [],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    numTicket,
    codEstadoProceso: estado,
    desEstadoProceso: `estado ${estado}`,
    codProceso: "10",
    desProceso: "proceso de prueba",
    perTributario: PERIODO,
    archivoReporte: archivos,
    ...extra,
  };
}
export function cuerpoTicket(registros: Record<string, unknown>[]): Record<string, unknown> {
  return { paginacion: { page: 1, perPage: 20, totalRegistros: registros.length }, registros };
}

// ── Fixtures y ZIP ──────────────────────────────────────────────────────────────────────────────────────────
const DIR_FIXTURES = join(__dirname, "..", "..", "..", "..", "..", "fixtures", "sire", "http");
export function fixture(nombre: string): Uint8Array {
  return new Uint8Array(readFileSync(join(DIR_FIXTURES, nombre)));
}
/** ZIP con un único TXT dentro (como el de SUNAT). */
export function zip(nombreTxt: string, contenido: Uint8Array): Uint8Array {
  return zipSync({ [nombreTxt]: contenido });
}
/** Cantidad de filas de datos de un TXT (líneas no vacías menos el encabezado). */
export function contarFilas(txt: Uint8Array): number {
  return Buffer.from(txt).toString("utf8").split("\n").filter((l) => l.trim() !== "").length - 1;
}
/** Valores de una columna (por nombre exacto del encabezado, sin BOM) de un TXT de fixture, en orden. */
export function columnaDe(txt: Uint8Array, nombre: string): string[] {
  const lineas = Buffer.from(txt).toString("utf8").replace(/^﻿/, "").split("\n").filter((l) => l.trim() !== "");
  const cab = lineas[0]!.split("|");
  const i = cab.indexOf(nombre);
  if (i < 0) throw new Error(`la columna ${nombre} no está en el fixture`);
  return lineas.slice(1).map((l) => l.split("|")[i]!);
}

// ── Guion de un flujo completo (exportar → ticket → archivos) ──────────────────────────────────────────────
export interface ParteFalsa {
  nombre: string;
  zip: Uint8Array;
  cod?: string | null;
}
export interface OpcionesFlujo {
  libro: "compras" | "ventas";
  numTicket?: string;
  partes: ParteFalsa[];
  periodo?: string;
}
/** Guiona el servidor `sire` con un ticket que ya está listo (estado 04) y los ZIP indicados. */
export function guionarFlujo(sire: ServidorSireFalso, o: OpcionesFlujo): { numTicket: string } {
  const numTicket = o.numTicket ?? "202610000001";
  const per = o.periodo ?? PERIODO;
  sire.guionar("GET", o.libro === "compras" ? RUTAS.exportarRce(per) : RUTAS.exportarRvie(per), { json: { numTicket } });
  sire.guionar("GET", RUTAS.ticket, {
    json: cuerpoTicket([registroTicket(numTicket, "04", o.partes.map((p) => archivo(p.nombre, p.cod === undefined ? "00" : p.cod)))]),
  });
  const porNombre = new Map(o.partes.map((p) => [p.nombre, p.zip]));
  const servirZip: GuionRespuesta = (p) => {
    const z = porNombre.get(p.query["nomArchivoReporte"] ?? "");
    return z === undefined ? { estado: 404 } : { bytes: z, cabeceras: { "content-type": "application/zip" } };
  };
  sire.guionar("GET", RUTAS.archivo, servirZip);
  return { numTicket };
}

/** Un flujo de compras de una sola parte con el fixture principal. */
export function parteCompras(nombre = "20700000002-20261101-1030-propuesta.zip"): ParteFalsa {
  return { nombre, zip: zip("20700000002-20261101-1030-propuesta.txt", fixture("compras-propuesta-202610.txt")) };
}
export function parteVentas(nombre = "LE20700000002202611001404001EXP2.zip"): ParteFalsa {
  return { nombre, zip: zip("LE20700000002202611001404001EXP2.txt", fixture("ventas-propuesta-202610.txt")) };
}

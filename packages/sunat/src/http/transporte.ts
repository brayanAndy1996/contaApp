/**
 * Una petición HTTP al SIRE (plan 041, «transporte.ts»): `fetch` con timeout, sin redirecciones, tope de bytes contado al
 * leer y mapeo HTTP → errores. Los errores llevan mensaje fijo y `detalle` literal: nunca la URL, las cabeceras, el cuerpo
 * ni la causa original (CA-12).
 */
import { MAX_BYTES_JSON } from "./endpoints.js";
import {
  ErrorCredencial,
  ErrorDatos,
  ErrorPortalSire,
  ErrorTransitorioSire,
  TokenRechazadoError,
} from "../errores.js";

/**
 * "token": endpoint OAuth de seguridad. "api": API del SIRE con token (exportar, consulta de ticket); un 404 es
 * `ErrorPortalSire` permanente. "descarga": la descarga del archivo (5.32), como "api" salvo que un 404 es transitorio (el
 * archivo aún no está listo). "solicitud-registro": la solicitud 5.51 del registro presentado (plan P-3): como "api", salvo que
 * un 400/422 lee el cuerpo de error y lanza `ErrorPortalSire("solicitud_rechazada")` con TODOS sus códigos; el cliente decide
 * cuáles son «sin datos» (`COD_SIN_DATOS_REGISTRO`). Si esa lectura se corta (timeout o red), es `ErrorTransitorioSire`.
 */
export type ContextoHttp = "token" | "api" | "descarga" | "solicitud-registro";

export interface PeticionTransporte {
  url: string;
  metodo: "GET" | "POST";
  cabeceras?: Record<string, string>;
  cuerpo?: string;
  contexto: ContextoHttp;
  timeoutMs: number;
  maxBytes: number;
  fetch?: typeof fetch;
}

export interface RespuestaTransporte {
  estado: number;
  /** Nombres en minúsculas. */
  cabeceras: Record<string, string>;
  cuerpo: Uint8Array;
}

/** Hace UNA petición. Devuelve solo respuestas 2xx; todo lo demás lanza un error del adaptador. */
export async function pedir(p: PeticionTransporte): Promise<RespuestaTransporte> {
  const f = p.fetch ?? globalThis.fetch;
  const init: RequestInit = {
    method: p.metodo,
    redirect: "manual",
    signal: AbortSignal.timeout(p.timeoutMs),
  };
  if (p.cabeceras !== undefined) init.headers = p.cabeceras;
  if (p.cuerpo !== undefined) init.body = p.cuerpo;

  let r: Response;
  try {
    r = await f(p.url, init);
  } catch (e) {
    throw errorDeRed(e);
  }

  if (r.status < 200 || r.status >= 300) {
    if (p.contexto === "solicitud-registro" && (r.status === 400 || r.status === 422)) {
      throw new ErrorPortalSire("solicitud_rechazada", await codigosDeError(r));
    }
    await descartar(r);
    throw errorDeEstado(p.contexto, r.status);
  }

  const cabeceras: Record<string, string> = {};
  r.headers.forEach((valor, nombre) => {
    cabeceras[nombre.toLowerCase()] = valor;
  });
  const cuerpo = await leerConTope(r, p.maxBytes);
  return { estado: r.status, cabeceras, cuerpo };
}

function errorDeEstado(contexto: ContextoHttp, estado: number): Error {
  if (estado >= 300 && estado < 400) return new ErrorPortalSire("respuesta_inesperada");
  if (estado === 429 || estado >= 500) return new ErrorTransitorioSire("servidor");
  if (contexto === "token") {
    if (estado === 400 || estado === 401) return new ErrorCredencial();
    return new ErrorPortalSire("respuesta_inesperada");
  }
  if (estado === 401) return new TokenRechazadoError();
  if (estado === 403) return new ErrorCredencial();
  if (estado === 422) return new ErrorDatos();
  if (estado === 404 && contexto === "descarga") return new ErrorTransitorioSire("servidor");
  return new ErrorPortalSire("respuesta_inesperada");
}

/**
 * Códigos de SUNAT del cuerpo de error de la solicitud 5.51: `errors[].cod` y luego el `cod` plano, en orden. Solo se leen
 * hasta `MAX_BYTES_JSON`; un cuerpo ilegible o demasiado grande da `[]`. Una lectura cortada (timeout o red) NO es un rechazo:
 * relanza el `ErrorTransitorioSire` de `leerConTope` (H-3). El `msg` (y todo lo demás) se descarta; el filtro de gramática y el
 * tope los aplica `ErrorPortalSire`.
 */
async function codigosDeError(r: Response): Promise<string[]> {
  let cuerpo: unknown;
  try {
    const bytes = await leerConTope(r, MAX_BYTES_JSON);
    cuerpo = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (e) {
    if (e instanceof ErrorTransitorioSire) throw e;
    await descartar(r);
    return [];
  }
  if (typeof cuerpo !== "object" || cuerpo === null) return [];
  const codigos: string[] = [];
  const errores = (cuerpo as { errors?: unknown }).errors;
  if (Array.isArray(errores)) {
    for (const e of errores) {
      const cod = typeof e === "object" && e !== null ? (e as { cod?: unknown }).cod : undefined;
      if (typeof cod === "string") codigos.push(cod);
    }
  }
  const plano = (cuerpo as { cod?: unknown }).cod;
  if (typeof plano === "string") codigos.push(plano);
  return codigos;
}

function esCorte(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const nombre = (e as { name?: unknown }).name;
  return nombre === "TimeoutError" || nombre === "AbortError";
}

/** Fallo de `fetch` o de la lectura del cuerpo: se descarta la causa (puede traer URL o secretos). */
function errorDeRed(e: unknown): ErrorTransitorioSire {
  return new ErrorTransitorioSire(esCorte(e) ? "timeout" : "red");
}

async function descartar(r: Response): Promise<void> {
  try {
    await r.body?.cancel();
  } catch {
    // el cuerpo de un error se descarta; si ya no se puede cancelar, no importa
  }
}

/** Lee el cuerpo contando los bytes recibidos (no confía en `Content-Length`); al pasarse cancela el flujo. */
async function leerConTope(r: Response, maxBytes: number): Promise<Uint8Array> {
  if (r.body === null) return new Uint8Array(0);
  const lector = r.body.getReader();
  const trozos: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let paso: ReadableStreamReadResult<Uint8Array>;
    try {
      paso = await lector.read();
    } catch (e) {
      throw errorDeRed(e);
    }
    if (paso.done) break;
    total += paso.value.byteLength;
    if (total > maxBytes) {
      try {
        await lector.cancel();
      } catch {
        // sin importancia: el error ya está decidido
      }
      throw new ErrorPortalSire("respuesta_inesperada");
    }
    trozos.push(paso.value);
  }
  const cuerpo = new Uint8Array(total);
  let pos = 0;
  for (const t of trozos) {
    cuerpo.set(t, pos);
    pos += t.byteLength;
  }
  return cuerpo;
}

import { open, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { ErrorDatos } from "../errores.js";

/**
 * Seguridad del acceso a fixtures (spec 009, D6). La clave de un comprobante se valida con una gramática
 * estricta antes de armar la ruta; después la ruta real (con `realpath`) debe quedar dentro de la carpeta
 * de fixtures, de modo que un enlace simbólico que salga se rechaza. Todo rechazo es `ErrorDatos`, con
 * mensaje fijo: nunca incluye la clave ni la ruta pedida.
 */

/** Tope de tamaño de un fixture XML (1 MiB). */
export const TOPE_BYTES_FIXTURE = 1_048_576;

const RE_RUC = /^[0-9]{11}$/;
const RE_TIPO = /^[0-9]{2}$/;
const RE_SERIE = /^[A-Z0-9]{4}$/;
const RE_NUMERO = /^[0-9]{1,8}$/;
const RE_CLAVE = /^([0-9]{11})-([0-9]{2})-([A-Z0-9]{4})-([0-9]{1,8})$/;

export interface PartesComprobante {
  rucEmisor: string;
  tipo: string;
  serie: string;
  numero: string;
}

/** Carpeta de fixtures XML por defecto, resuelta desde este archivo (igual en `src` y `dist`), no desde el `cwd`. */
export function dirFixturesXmlPorDefecto(): string {
  // El paquete compila a CommonJS: `__dirname` (también lo provee vitest).
  return resolve(__dirname, "../../../../fixtures/xml");
}

/** `true` si las cuatro partes cumplen la gramática de D6. No toca el disco. */
export function esComprobanteValido(p: PartesComprobante): boolean {
  return (
    typeof p.rucEmisor === "string" &&
    typeof p.tipo === "string" &&
    typeof p.serie === "string" &&
    typeof p.numero === "string" &&
    RE_RUC.test(p.rucEmisor) &&
    RE_TIPO.test(p.tipo) &&
    RE_SERIE.test(p.serie) &&
    RE_NUMERO.test(p.numero)
  );
}

/** Lanza `ErrorDatos` si las partes no cumplen la gramática; devuelve la clave `{ruc}-{tipo}-{serie}-{numero}`. */
export function claveDeComprobante(p: PartesComprobante): string {
  if (!esComprobanteValido(p)) throw new ErrorDatos();
  return `${p.rucEmisor}-${p.tipo}-${p.serie}-${p.numero}`;
}

/** Descompone una clave ya armada; lanza `ErrorDatos` si no cumple la gramática. */
export function partesDeClave(clave: string): PartesComprobante {
  const m = typeof clave === "string" ? RE_CLAVE.exec(clave) : null;
  if (m === null) throw new ErrorDatos();
  const [, rucEmisor, tipo, serie, numero] = m as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];
  return { rucEmisor, tipo, serie, numero };
}

/**
 * Lee `{dir}/{clave}.xml`. Devuelve `null` si no existe. Lanza `ErrorDatos` si la clave no cumple la
 * gramática, si la ruta real sale de `dir` (enlace simbólico), si no es un archivo regular o si supera
 * `TOPE_BYTES_FIXTURE`. Abre el archivo ya resuelto y comprueba el tamaño sobre el descriptor abierto.
 */
export async function leerFixtureXml(
  dir: string,
  clave: string,
): Promise<string | null> {
  partesDeClave(clave); // gramática antes de armar la ruta
  let base: string;
  try {
    base = await realpath(dir);
  } catch (e) {
    if (codigoFs(e) === "ENOENT" || codigoFs(e) === "ENOTDIR") return null;
    throw new ErrorDatos();
  }

  let real: string;
  try {
    real = await realpath(join(base, `${clave}.xml`));
  } catch (e) {
    if (codigoFs(e) === "ENOENT") return null;
    throw new ErrorDatos();
  }
  if (!real.startsWith(base + sep)) throw new ErrorDatos();

  let archivo;
  try {
    archivo = await open(real, "r");
  } catch {
    throw new ErrorDatos();
  }
  try {
    const st = await archivo.stat();
    if (!st.isFile() || st.size > TOPE_BYTES_FIXTURE) throw new ErrorDatos();
    return await archivo.readFile("utf8");
  } catch (e) {
    if (e instanceof ErrorDatos) throw e;
    throw new ErrorDatos();
  } finally {
    await archivo.close();
  }
}

function codigoFs(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e
    ? String((e as { code: unknown }).code)
    : undefined;
}

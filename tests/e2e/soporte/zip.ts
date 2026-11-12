// Lectura mínima de un ZIP de una sola entrada (el que arma `empaquetar` de 012: nivel 6, sin comentario).
// Sirve a los flujos para abrir el archivo descargado y contar las líneas del TXT. No es un lector general.
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";

export interface EntradaZip {
  readonly nombre: string;
  readonly bytes: Buffer;
}

/** La primera entrada del ZIP, leída desde su cabecera local (las medidas van ahí). */
export function primeraEntradaZip(zip: Buffer): EntradaZip {
  if (zip.length < 30 || zip.readUInt32LE(0) !== 0x04034b50) {
    throw new Error("No es un ZIP: falta la cabecera local.");
  }
  const metodo = zip.readUInt16LE(8);
  const comprimido = zip.readUInt32LE(18);
  const largoNombre = zip.readUInt16LE(26);
  const largoExtra = zip.readUInt16LE(28);
  const inicio = 30 + largoNombre + largoExtra;
  const datos = zip.subarray(inicio, inicio + comprimido);
  if (metodo !== 0 && metodo !== 8) {
    throw new Error(`Método de compresión no soportado (${metodo}).`);
  }
  return {
    nombre: zip.subarray(30, 30 + largoNombre).toString("utf8"),
    bytes: metodo === 8 ? inflateRawSync(datos) : Buffer.from(datos),
  };
}

export const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Líneas no vacías de un TXT (el archivo del SIRE termina con salto de línea). */
export function lineasDe(txt: Buffer): string[] {
  return txt
    .toString("latin1")
    .split(/\r?\n/)
    .filter((l) => l !== "");
}

// Empaquetado ZIP en memoria con SHA-256 (spec 012: D6, D7, CA-10; plan, Decisiones «empaquetar» y
// Ratificación 14). Una sola entrada, nivel 6 fijo, sin comentarios ni campos extra, sin disco ni
// reloj: la fecha llega como parámetro y el sello DOS lleva sus campos UTC.
import { createHash } from "node:crypto";
import { validarNombreArchivo } from "@contapp/domain";
import { zipSync } from "fflate";

/** Todo rechazo de `empaquetar`. El mensaje es fijo: nunca incluye los nombres ni los bytes recibidos. */
export class EmpaquetadoInvalidoError extends Error {
  readonly codigo = "EMPAQUETADO_INVALIDO";
  constructor() {
    super("No se puede empaquetar: los datos de entrada no son válidos");
    this.name = "EmpaquetadoInvalidoError";
  }
}

export interface NombresEmpaquetado {
  nombreTxt: string;
  nombreZip: string;
}

export interface Empaquetado {
  zip: Uint8Array;
  nombreZip: string;
  /** SHA-256 de los bytes del TXT, en hexadecimal minúsculo. */
  sha256Txt: string;
  /** SHA-256 de los bytes del ZIP, en hexadecimal minúsculo. */
  sha256Zip: string;
}

/** Rango del sello DOS: 7 bits de año desde 1980 (plan, Ratificación 14). */
const ANIO_DOS_MIN = 1980;
const ANIO_DOS_MAX = 2107;

/**
 * Fecha que se le pasa a fflate solo para que escriba algo: fflate usa la hora local y su rango
 * termina en 2099, así que el sello real se escribe después con `sellarFechaDos`.
 */
const FECHA_PROVISIONAL = new Date(2000, 0, 1);

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Fecha y hora DOS (MS-DOS, 2 s de resolución) con los campos UTC de `fecha`. */
function fechaDos(fecha: Date): { hora: number; dia: number } {
  const hora = (fecha.getUTCHours() << 11) | (fecha.getUTCMinutes() << 5) | (fecha.getUTCSeconds() >> 1);
  const dia = ((fecha.getUTCFullYear() - ANIO_DOS_MIN) << 9) | ((fecha.getUTCMonth() + 1) << 5) | fecha.getUTCDate();
  return { hora, dia };
}

/**
 * Reescribe el sello de la única entrada en la cabecera local (offset 0) y en la del directorio
 * central (su offset está en el registro de fin, los últimos 22 bytes porque no hay comentario).
 * Depende de la estructura que escribe `zipSync` de fflate 0.8.2 (versión exacta en package.json).
 */
function sellarFechaDos(zip: Uint8Array, fecha: Date): void {
  const vista = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const { hora, dia } = fechaDos(fecha);
  const finCentral = zip.byteLength - 22;
  const central = vista.getUint32(finCentral + 16, true);
  for (const [offHora, offDia] of [
    [10, 12],
    [central + 12, central + 14],
  ] as const) {
    vista.setUint16(offHora, hora, true);
    vista.setUint16(offDia, dia, true);
  }
}

function fechaValida(fecha: unknown): fecha is Date {
  if (!(fecha instanceof Date) || Number.isNaN(fecha.getTime())) return false;
  const anio = fecha.getUTCFullYear();
  return anio >= ANIO_DOS_MIN && anio <= ANIO_DOS_MAX;
}

function nombresValidos(nombres: unknown): nombres is NombresEmpaquetado {
  if (typeof nombres !== "object" || nombres === null) return false;
  const { nombreTxt, nombreZip } = nombres as Record<string, unknown>;
  if (!validarNombreArchivo(nombreTxt as string) || !validarNombreArchivo(nombreZip as string)) return false;
  const txt = nombreTxt as string;
  return txt.endsWith(".txt") && nombreZip === `${txt.slice(0, -4)}.zip`;
}

/**
 * Empaqueta `txt` en un ZIP con una sola entrada llamada `nombreTxt` y devuelve los SHA-256 del TXT y
 * del ZIP. Determinista: los mismos bytes, nombres e instante dan el mismo ZIP en cualquier huso
 * horario. Lanza EmpaquetadoInvalidoError si `txt` no es Uint8Array, si algún nombre no cumple la
 * gramática de domain o no se corresponden, o si `fecha` no es una Date entre 1980 y 2107 (UTC).
 */
export function empaquetar(txt: Uint8Array, nombres: NombresEmpaquetado, fecha: Date): Empaquetado {
  if (!(txt instanceof Uint8Array) || !nombresValidos(nombres) || !fechaValida(fecha)) {
    throw new EmpaquetadoInvalidoError();
  }
  const { nombreTxt, nombreZip } = nombres;
  const zip = zipSync({ [nombreTxt]: [txt, { level: 6, mtime: FECHA_PROVISIONAL }] });
  sellarFechaDos(zip, fecha);
  return { zip, nombreZip, sha256Txt: sha256(txt), sha256Zip: sha256(zip) };
}

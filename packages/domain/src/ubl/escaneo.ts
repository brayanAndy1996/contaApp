// Spec 016 (D-1, P-5, plan «Parser seguro», pasos 1 y 2): comprobaciones sobre los BYTES antes de decodificar o parsear.
// Pasadas lineales, sin recursión ni expresiones regulares sobre la entrada: un XML hostil se rechaza en tiempo proporcional
// a su tamaño (≤ 1 MiB). Es `xml_invalido`:
//  - más de 1 MiB; un BOM de UTF-16; cualquier byte 0x00;
//  - cualquier `<!DOCTYPE` o `<!ENTITY` (sin distinguir mayúsculas), aunque esté dentro de un comentario o de un CDATA;
//  - toda otra declaración `<!` que no sea comentario ni `<![CDATA[`;
//  - una profundidad de elementos mayor que 32 o más de 2.000 líneas (`InvoiceLine|CreditNoteLine|DebitNoteLine`);
//  - un comentario, CDATA, instrucción o etiqueta sin cerrar.
// Las marcas que se buscan son ASCII, que ocupa los mismos bytes en UTF-8 y en ISO-8859-1.
import type { Entero } from "../texto/index";
import { invalido } from "./tipos";

export const TOPE_BYTES: Entero = 1_048_576;
export const TOPE_ITEMS: Entero = 2_000;
export const TOPE_PROFUNDIDAD: Entero = 32;

const MENOR = 0x3c; // <
const MAYOR = 0x3e; // >
const EXCLAMACION = 0x21; // !
const INTERROGACION = 0x3f; // ?
const BARRA = 0x2f; // /
const DOS_PUNTOS = 0x3a; // :
const COMILLAS = 0x22; // "
const APOSTROFO = 0x27; // '

const ascii = (texto: string): readonly Entero[] => Array.from(texto, (c) => c.charCodeAt(0));
const DOCTYPE = ascii("doctype");
const ENTITY = ascii("entity");
const COMENTARIO = ascii("--");
const CDATA = ascii("[CDATA[");
const FIN_COMENTARIO = ascii("-->");
const FIN_CDATA = ascii("]]>");
const FIN_INSTRUCCION = ascii("?>");
const LINEAS = ["InvoiceLine", "CreditNoteLine", "DebitNoteLine"].map(ascii);

/** `true` si en `desde` empieza `marca` (en minúsculas: compara sin distinguir mayúsculas las letras ASCII). */
function empiezaSinCaso(b: Uint8Array, desde: Entero, marca: readonly Entero[]): boolean {
  if (desde + marca.length > b.length) return false;
  for (let k = 0; k < marca.length; k++) {
    if ((b[desde + k]! | 0x20) !== marca[k]) return false;
  }
  return true;
}

function empieza(b: Uint8Array, desde: Entero, marca: readonly Entero[]): boolean {
  if (desde + marca.length > b.length) return false;
  for (let k = 0; k < marca.length; k++) {
    if (b[desde + k] !== marca[k]) return false;
  }
  return true;
}

/** Posición donde empieza `marca` a partir de `desde`; sin ella, `xml_invalido` (construcción sin cerrar). */
function buscar(b: Uint8Array, desde: Entero, marca: readonly Entero[]): Entero {
  for (let i = desde; i + marca.length <= b.length; i++) {
    if (b[i] === marca[0] && empieza(b, i, marca)) return i;
  }
  return invalido();
}

/** Posición del `>` que cierra la etiqueta abierta en `desde`, saltando los valores de atributo entre comillas. */
function finEtiqueta(b: Uint8Array, desde: Entero): Entero {
  let comilla: Entero = 0;
  for (let i = desde; i < b.length; i++) {
    const c = b[i];
    if (comilla !== 0) {
      if (c === comilla) comilla = 0;
    } else if (c === COMILLAS || c === APOSTROFO) {
      comilla = c;
    } else if (c === MAYOR) {
      return i;
    } else if (c === MENOR) {
      return invalido();
    }
  }
  return invalido();
}

const finDeNombre = (c: Entero | undefined): boolean =>
  c === undefined || c === MAYOR || c === BARRA || c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;

/** `true` si la etiqueta que empieza en `desde` se llama (sin prefijo) como una línea de comprobante. */
function esLinea(b: Uint8Array, desde: Entero): boolean {
  let fin = desde;
  let local = desde;
  while (!finDeNombre(b[fin])) {
    if (b[fin] === DOS_PUNTOS) local = fin + 1;
    fin++;
  }
  return LINEAS.some((l) => l.length === fin - local && empieza(b, local, l));
}

/** Pasada 1: tamaño, BOM de UTF-16, NUL y cualquier `<!DOCTYPE` o `<!ENTITY`. */
function escanearBytes(b: Uint8Array): void {
  if (b.length > TOPE_BYTES) invalido();
  if (b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff))) invalido();
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c === 0x00) invalido();
    if (c === MENOR && b[i + 1] === EXCLAMACION && (empiezaSinCaso(b, i + 2, DOCTYPE) || empiezaSinCaso(b, i + 2, ENTITY))) {
      invalido();
    }
  }
}

/** Pasada 2: declaraciones `<!`, profundidad y número de líneas. */
function escanearEstructura(b: Uint8Array): void {
  let profundidad: Entero = 0;
  let lineas: Entero = 0;
  let i: Entero = 0;
  while (i < b.length) {
    if (b[i] !== MENOR) {
      i++;
      continue;
    }
    const siguiente = b[i + 1];
    if (siguiente === EXCLAMACION) {
      if (empieza(b, i + 2, COMENTARIO)) i = buscar(b, i + 4, FIN_COMENTARIO) + FIN_COMENTARIO.length;
      else if (empieza(b, i + 2, CDATA)) i = buscar(b, i + 2 + CDATA.length, FIN_CDATA) + FIN_CDATA.length;
      else invalido();
      continue;
    }
    if (siguiente === INTERROGACION) {
      i = buscar(b, i + 2, FIN_INSTRUCCION) + FIN_INSTRUCCION.length;
      continue;
    }
    const fin = finEtiqueta(b, i + 1);
    if (siguiente === BARRA) {
      profundidad--;
    } else if (b[fin - 1] !== BARRA) {
      profundidad++;
      if (profundidad > TOPE_PROFUNDIDAD) invalido();
      if (esLinea(b, i + 1)) {
        lineas++;
        if (lineas > TOPE_ITEMS) invalido();
      }
    }
    i = fin + 1;
  }
}

/** Pasos 1 y 2 del parser seguro: lanza `UblError("xml_invalido")` sin mirar el contenido más allá de las marcas. */
export function escanear(bytes: Uint8Array): void {
  escanearBytes(bytes);
  escanearEstructura(bytes);
}

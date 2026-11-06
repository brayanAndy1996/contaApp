// Spec 012 (D2, D13; plan, Contratos `texto/`): texto -> bytes según la codificación del formato,
// sin `TextEncoder` ni `Buffer` (no están en `lib` ES2023 ni se permiten en domain). Nunca
// sustituye: un carácter que no cabe, o un sustituto UTF-16 suelto, lanza.
import type { Entero } from "./entero";

/** Error con código estable y mensaje fijo: nunca incluye el carácter ni el texto. */
export class CaracterNoCodificableError extends Error {
  readonly codigo = "CARACTER_NO_CODIFICABLE";

  constructor() {
    super("El texto tiene un carácter que no cabe en la codificación del formato.");
    this.name = new.target.name;
  }
}

/**
 * Codifica `texto` en un `Uint8Array` nuevo. `ascii` admite U+0000-U+007F, `latin1` U+0000-U+00FF
 * (un byte por carácter) y `utf8` cualquier punto de código bien formado (1 a 4 bytes).
 * Lanza `CaracterNoCodificableError` si el texto no es string, la codificación es desconocida o un
 * carácter no cabe.
 */
export function codificar(texto: string, codificacion: "ascii" | "latin1" | "utf8"): Uint8Array {
  if (typeof texto !== "string") throw new CaracterNoCodificableError();
  if (codificacion === "utf8") return utf8(texto);
  if (codificacion !== "ascii" && codificacion !== "latin1") throw new CaracterNoCodificableError();
  const maximo = codificacion === "ascii" ? 0x7f : 0xff;
  const bytes = new Uint8Array(texto.length);
  for (let i = 0; i < texto.length; i++) {
    const c = texto.charCodeAt(i);
    if (c > maximo) throw new CaracterNoCodificableError();
    bytes[i] = c;
  }
  return bytes;
}

/** UTF-8 estricto: un par sustituto da 4 bytes; un sustituto suelto lanza (nunca U+FFFD). */
function utf8(texto: string): Uint8Array {
  // Cada unidad UTF-16 da a lo sumo 3 bytes (un par de 2 unidades da 4).
  const bytes = new Uint8Array(texto.length * 3);
  let n: Entero = 0;
  for (let i = 0; i < texto.length; i++) {
    const c = texto.charCodeAt(i);
    if (c < 0x80) {
      bytes[n++] = c;
    } else if (c < 0x800) {
      bytes[n++] = 0xc0 | (c >> 6);
      bytes[n++] = 0x80 | (c & 0x3f);
    } else if (c >= 0xd800 && c <= 0xdbff) {
      const bajo = i + 1 < texto.length ? texto.charCodeAt(i + 1) : 0;
      if (bajo < 0xdc00 || bajo > 0xdfff) throw new CaracterNoCodificableError();
      const p = 0x10000 + ((c - 0xd800) << 10) + (bajo - 0xdc00);
      bytes[n++] = 0xf0 | (p >> 18);
      bytes[n++] = 0x80 | ((p >> 12) & 0x3f);
      bytes[n++] = 0x80 | ((p >> 6) & 0x3f);
      bytes[n++] = 0x80 | (p & 0x3f);
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw new CaracterNoCodificableError();
    } else {
      bytes[n++] = 0xe0 | (c >> 12);
      bytes[n++] = 0x80 | ((c >> 6) & 0x3f);
      bytes[n++] = 0x80 | (c & 0x3f);
    }
  }
  return bytes.slice(0, n);
}

// Spec 016 (D-1, plan «Parser seguro», paso 3): bytes → texto según la codificación declarada, sin `TextDecoder` (prohibido
// en domain). Solo `UTF-8` (también sin declaración o con BOM UTF-8) e `ISO-8859-1`; cualquier otra es `xml_invalido`.
// UTF-8 estricto: una secuencia mal formada, larga de más, un sustituto o un punto de código fuera de rango son
// `xml_invalido` (nunca U+FFFD).
import type { Entero } from "../texto/index";
import { invalido } from "./tipos";

type Codificacion = "utf8" | "latin1";

/**
 * Gramática estricta de la declaración (XML 1.0 §2.8 y §4.3.3): `version`, luego `encoding` y `standalone` opcionales, en ese
 * orden y una sola vez, con la misma comilla a cada lado y un `EncName` sin espacios. Todo lo demás es ambiguo (H-016-6).
 */
const DECLARACION =
  /^<\?xml[ \t\r\n]+version[ \t\r\n]*=[ \t\r\n]*(?:"1\.[0-9]{1,3}"|'1\.[0-9]{1,3}')(?:[ \t\r\n]+encoding[ \t\r\n]*=[ \t\r\n]*(?:"([A-Za-z][A-Za-z0-9._-]{0,39})"|'([A-Za-z][A-Za-z0-9._-]{0,39})'))?(?:[ \t\r\n]+standalone[ \t\r\n]*=[ \t\r\n]*(?:"(?:yes|no)"|'(?:yes|no)'))?[ \t\r\n]*\?>/;
/** `<?xml` seguido de un espacio: es la declaración (no una instrucción `<?xml-…`). */
const INICIO_DECLARACION = /^<\?xml[ \t\r\n]/;
const LARGO_MAX_DECLARACION: Entero = 512;
const TROZO: Entero = 8_192;

const esBomUtf8 = (b: Uint8Array): boolean => b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;

/** Texto Latin-1 de `b[desde, hasta)` (cada byte, un carácter). */
function latin1(b: Uint8Array, desde: Entero, hasta: Entero): string {
  let salida = "";
  for (let i = desde; i < hasta; i += TROZO) {
    salida += String.fromCharCode(...b.subarray(i, i + TROZO < hasta ? i + TROZO : hasta));
  }
  return salida;
}

/**
 * Codificación declarada en `<?xml … encoding="…"?>`; sin declaración o sin `encoding`, UTF-8. Una declaración que no cumple la
 * gramática estricta (atributo repetido o parecido, comillas mal puestas, espacios en el nombre, sin cerrar) es `xml_invalido`.
 */
function codificacionDeclarada(b: Uint8Array, desde: Entero): Codificacion {
  const cabecera = latin1(b, desde, desde + LARGO_MAX_DECLARACION < b.length ? desde + LARGO_MAX_DECLARACION : b.length);
  if (!INICIO_DECLARACION.test(cabecera)) return "utf8";
  const m = DECLARACION.exec(cabecera) ?? invalido();
  const declarado = m[1] ?? m[2];
  if (declarado === undefined) return "utf8";
  const nombre = declarado.toLowerCase();
  if (nombre === "utf-8") return "utf8";
  if (nombre === "iso-8859-1") return "latin1";
  return invalido();
}

const continuacion = (c: Entero | undefined): boolean => c !== undefined && (c & 0xc0) === 0x80;

/** UTF-8 estricto (RFC 3629) → unidades UTF-16. */
function utf8(b: Uint8Array, desde: Entero): string {
  const unidades = new Uint16Array(b.length);
  let n: Entero = 0;
  let i = desde;
  while (i < b.length) {
    const c0 = b[i]!;
    let punto: Entero;
    if (c0 < 0x80) {
      punto = c0;
      i += 1;
    } else if (c0 >= 0xc2 && c0 <= 0xdf) {
      if (!continuacion(b[i + 1])) invalido();
      punto = ((c0 & 0x1f) << 6) | (b[i + 1]! & 0x3f);
      i += 2;
    } else if (c0 >= 0xe0 && c0 <= 0xef) {
      const c1 = b[i + 1];
      if (!continuacion(c1) || !continuacion(b[i + 2])) invalido();
      if ((c0 === 0xe0 && c1! < 0xa0) || (c0 === 0xed && c1! > 0x9f)) invalido();
      punto = ((c0 & 0x0f) << 12) | ((c1! & 0x3f) << 6) | (b[i + 2]! & 0x3f);
      i += 3;
    } else if (c0 >= 0xf0 && c0 <= 0xf4) {
      const c1 = b[i + 1];
      if (!continuacion(c1) || !continuacion(b[i + 2]) || !continuacion(b[i + 3])) invalido();
      if ((c0 === 0xf0 && c1! < 0x90) || (c0 === 0xf4 && c1! > 0x8f)) invalido();
      punto = ((c0 & 0x07) << 18) | ((c1! & 0x3f) << 12) | ((b[i + 2]! & 0x3f) << 6) | (b[i + 3]! & 0x3f);
      i += 4;
    } else {
      return invalido();
    }
    if (punto >= 0x10000) {
      const p = punto - 0x10000;
      unidades[n++] = 0xd800 | (p >> 10);
      unidades[n++] = 0xdc00 | (p & 0x3ff);
    } else {
      unidades[n++] = punto;
    }
  }
  let salida = "";
  for (let k = 0; k < n; k += TROZO) {
    salida += String.fromCharCode(...unidades.subarray(k, k + TROZO < n ? k + TROZO : n));
  }
  return salida;
}

/** Bytes ya escaneados → texto. `xml_invalido` si la codificación no está admitida o los bytes no la respetan. */
export function decodificar(bytes: Uint8Array): string {
  const conBom = esBomUtf8(bytes);
  const desde = conBom ? 3 : 0;
  const codificacion = codificacionDeclarada(bytes, desde);
  if (codificacion === "latin1") {
    if (conBom) invalido();
    return latin1(bytes, 0, bytes.length);
  }
  return utf8(bytes, desde);
}

// Spec 023 (CA-8, D-3): HTML de SUNAT → texto plano. Nunca llega HTML al navegador.
// Tokenizador propio en una sola pasada, sin DOM ni expresiones regulares: cada búsqueda avanza
// la posición o termina la entrada, así que el costo es lineal aun con entradas hostiles.

export const TOPE_TEXTO_PLANO = 1024 * 1024;

/** Elementos cuyo contenido se descarta entero (texto crudo, metadatos o no visibles). */
const DESCARTAR_CONTENIDO: ReadonlySet<string> = new Set([
  "script",
  "style",
  "template",
  "noscript",
  "iframe",
  "noembed",
  "noframes",
  "xmp",
  "title",
  "textarea",
  "select",
  "svg",
  "math",
]);

/** Elementos de bloque: su apertura y su cierre separan líneas. */
const BLOQUES: ReadonlySet<string> = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "caption",
  "center",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "tfoot",
  "thead",
  "tr",
  "ul",
]);

/** Celdas: separan con un espacio. */
const CELDAS: ReadonlySet<string> = new Set(["td", "th"]);

const ENTIDADES: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", " "],
  ["aacute", "á"],
  ["eacute", "é"],
  ["iacute", "í"],
  ["oacute", "ó"],
  ["uacute", "ú"],
  ["Aacute", "Á"],
  ["Eacute", "É"],
  ["Iacute", "Í"],
  ["Oacute", "Ó"],
  ["Uacute", "Ú"],
  ["ntilde", "ñ"],
  ["Ntilde", "Ñ"],
  ["uuml", "ü"],
  ["Uuml", "Ü"],
  ["iexcl", "¡"],
  ["iquest", "¿"],
  ["ordm", "º"],
  ["ordf", "ª"],
  ["deg", "°"],
  ["laquo", "«"],
  ["raquo", "»"],
  ["copy", "©"],
  ["reg", "®"],
  ["euro", "€"],
  ["ndash", "–"],
  ["mdash", "—"],
  ["hellip", "…"],
  ["bull", "•"],
  ["middot", "·"],
  ["lsquo", "‘"],
  ["rsquo", "’"],
  ["ldquo", "“"],
  ["rdquo", "”"],
]);

const LARGO_MAXIMO_ENTIDAD = 10;
const SUSTITUTO = "�";

function esLetraAscii(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function esDigito(c: number): boolean {
  return c >= 48 && c <= 57;
}

function esHex(c: number): boolean {
  return esDigito(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
}

function esAlfanumerico(c: number): boolean {
  return esLetraAscii(c) || esDigito(c);
}

/** Espacio en blanco de HTML: espacio, tab, LF, FF, CR. */
function esBlanco(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
}

/** Fin del nombre de una etiqueta. */
function terminaNombre(c: number): boolean {
  return Number.isNaN(c) || esBlanco(c) || c === 47 || c === 62;
}

/** Salida con espacios colapsados, a lo más una línea en blanco seguida y tope de tamaño. */
class Salida {
  private readonly partes: string[] = [];
  private largo = 0;
  private espacioPendiente = false;
  private saltosAlFinal = 0;

  get llena(): boolean {
    return this.largo >= TOPE_TEXTO_PLANO;
  }

  texto(t: string): void {
    if (t.length === 0) return;
    if (this.espacioPendiente && this.largo > 0 && this.saltosAlFinal === 0) {
      this.agregar(" ");
    }
    this.espacioPendiente = false;
    this.saltosAlFinal = 0;
    this.agregar(t);
  }

  espacio(): void {
    this.espacioPendiente = true;
  }

  /** `forzado` (br): salto aunque ya haya uno, hasta una línea en blanco. */
  salto(forzado: boolean): void {
    this.espacioPendiente = false;
    if (this.largo === 0) return;
    if (this.saltosAlFinal >= (forzado ? 2 : 1)) return;
    this.saltosAlFinal += 1;
    this.agregar("\n");
  }

  resultado(): string {
    let r = this.partes.join("");
    if (r.length > TOPE_TEXTO_PLANO) {
      r = r.slice(0, TOPE_TEXTO_PLANO);
      const ultimo = r.charCodeAt(r.length - 1);
      if (ultimo >= 0xd800 && ultimo <= 0xdbff) r = r.slice(0, -1);
    }
    return r.trimEnd();
  }

  private agregar(t: string): void {
    this.partes.push(t);
    this.largo += t.length;
  }
}

/**
 * Posición tras el `>` que cierra una etiqueta que empieza en `desde` (ya pasado el nombre).
 * Un `>` dentro de un valor de atributo entre comillas no la cierra. `-1` si la entrada termina
 * antes (la etiqueta sin cerrar se descarta con lo que sigue).
 */
function finDeEtiqueta(html: string, desde: number): number {
  let i = desde;
  while (i < html.length) {
    const c = html.charCodeAt(i);
    if (c === 62) return i + 1;
    if (c === 61) {
      i += 1;
      while (i < html.length && esBlanco(html.charCodeAt(i))) i += 1;
      const q = html.charCodeAt(i);
      if (q === 34 || q === 39) {
        const cierre = html.indexOf(q === 34 ? '"' : "'", i + 1);
        if (cierre < 0) return -1;
        i = cierre + 1;
      }
      continue;
    }
    i += 1;
  }
  return -1;
}

/** Nombre de etiqueta en minúsculas ASCII desde `desde`; devuelve también dónde termina. */
function leerNombre(html: string, desde: number): [string, number] {
  let i = desde;
  while (!terminaNombre(html.charCodeAt(i))) i += 1;
  return [html.slice(desde, i).toLowerCase(), i];
}

/**
 * Posición tras el cierre `</nombre ...>` de un elemento de contenido descartado, o `-1` si no
 * se cierra. Cada `</` que no es el cierre se salta: la búsqueda solo avanza.
 */
function finDeContenido(html: string, desde: number, nombre: string): number {
  let i = desde;
  for (;;) {
    const abre = html.indexOf("</", i);
    if (abre < 0) return -1;
    const inicio = abre + 2;
    const candidato = html.slice(inicio, inicio + nombre.length);
    if (
      candidato.toLowerCase() === nombre &&
      terminaNombre(html.charCodeAt(inicio + nombre.length))
    ) {
      return finDeEtiqueta(html, inicio + nombre.length);
    }
    i = inicio;
  }
}

/** Decodifica una referencia que empieza en `&` (posición `i`). */
function leerEntidad(html: string, i: number): [string, number] {
  const c1 = html.charCodeAt(i + 1);
  if (c1 === 35) {
    const hex = html.charCodeAt(i + 2) === 120 || html.charCodeAt(i + 2) === 88;
    let j = i + (hex ? 3 : 2);
    const inicio = j;
    while (
      j < html.length &&
      (hex ? esHex(html.charCodeAt(j)) : esDigito(html.charCodeAt(j)))
    ) {
      j += 1;
    }
    if (j === inicio) return ["&", i + 1];
    const digitos = html.slice(inicio, j);
    if (html.charCodeAt(j) === 59) j += 1;
    // Más de 8 cifras ya está fuera de Unicode; no se convierte para no perder precisión.
    const cp = digitos.length > 8 ? -1 : parseInt(digitos, hex ? 16 : 10);
    const valido =
      cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
    if (!valido) return [SUSTITUTO, j];
    if (esBlanco(cp)) return [" ", j];
    // Otros controles C0 y C1: fuera.
    if (cp < 32 || (cp >= 127 && cp <= 159)) return ["", j];
    return [String.fromCodePoint(cp), j];
  }
  let j = i + 1;
  while (
    j < html.length &&
    j - i - 1 < LARGO_MAXIMO_ENTIDAD &&
    esAlfanumerico(html.charCodeAt(j))
  ) {
    j += 1;
  }
  const valor = ENTIDADES.get(html.slice(i + 1, j));
  if (valor === undefined) return ["&", i + 1];
  if (html.charCodeAt(j) === 59) j += 1;
  return [valor, j];
}

export function htmlATextoPlano(html: string): string {
  const salida = new Salida();
  const n = html.length;
  let i = 0;
  while (i < n && !salida.llena) {
    const c = html.charCodeAt(i);

    if (c === 60) {
      const c1 = html.charCodeAt(i + 1);
      // Comentario: se descarta con su contenido; sin cerrar, hasta el final.
      if (html.startsWith("<!--", i)) {
        const cierre = html.indexOf("-->", i + 4);
        if (cierre < 0) break;
        i = cierre + 3;
        continue;
      }
      // Declaraciones, CDATA, instrucciones de proceso y cierres sin nombre: hasta el próximo `>`.
      if (c1 === 33 || c1 === 63 || (c1 === 47 && !esLetraAscii(html.charCodeAt(i + 2)))) {
        const cierre = html.indexOf(">", i + 2);
        if (cierre < 0) break;
        i = cierre + 1;
        continue;
      }
      const esCierre = c1 === 47;
      const inicioNombre = i + (esCierre ? 2 : 1);
      if (!esLetraAscii(html.charCodeAt(inicioNombre))) {
        // `<` suelto: es texto.
        salida.texto("<");
        i += 1;
        continue;
      }
      const [nombre, finNombre] = leerNombre(html, inicioNombre);
      const fin = finDeEtiqueta(html, finNombre);
      if (fin < 0) break;
      i = fin;
      if (!esCierre && DESCARTAR_CONTENIDO.has(nombre)) {
        const finContenido = finDeContenido(html, i, nombre);
        if (finContenido < 0) break;
        i = finContenido;
        continue;
      }
      if (nombre === "br") salida.salto(true);
      else if (BLOQUES.has(nombre)) salida.salto(false);
      else if (CELDAS.has(nombre)) salida.espacio();
      continue;
    }

    if (c === 38) {
      const [valor, siguiente] = leerEntidad(html, i);
      salida.texto(valor);
      i = siguiente;
      continue;
    }

    if (esBlanco(c)) {
      salida.espacio();
      i += 1;
      continue;
    }

    // Tramo de texto común hasta el próximo `<`, `&`, blanco o NUL.
    let j = i;
    while (j < n) {
      const d = html.charCodeAt(j);
      if (d === 60 || d === 38 || d === 0 || esBlanco(d)) break;
      j += 1;
    }
    if (j === i) {
      i += 1; // NUL: se descarta.
      continue;
    }
    salida.texto(html.slice(i, j));
    i = j;
  }
  return salida.resultado();
}

// Spec 028 · T8: saneo de textos de usuario para el correo (R-6, CA-7). Lógica pura, lineal, sin IO.

const SALTOS = /[\t\n\v\f\r\u0085\u2028\u2029]/gu;
const INVISIBLES = /[\p{Cc}\p{Cf}]/gu;
const ESPACIOS = /\s+/gu;

/**
 * Escapa `& < > " '` en una sola pasada (`&amp; &lt; &gt; &quot; &#39;`). No quita nada más: los controles y el formato invisible
 * ya salen de `limpiarLinea`.
 */
export function escaparHtml(s: string): string {
  return s.replace(/[&<>"']/gu, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

/**
 * Deja `s` en una sola línea: CR, LF, tabulador y separadores de línea pasan a espacio, los controles (`\p{Cc}`) y el formato invisible
 * (`\p{Cf}`: bidi, ancho cero, BOM) se quitan, los espacios se colapsan y los extremos se recortan. Después de limpiar, si pasa de `max`
 * puntos de código lo corta a `max − 1` y añade «…» (el resultado mide como máximo `max`). No escapa HTML.
 */
export function limpiarLinea(s: string, max: number): string {
  return recortar(sinControles(s), max);
}

function sinControles(s: string): string {
  return s.replace(SALTOS, " ").replace(INVISIBLES, "").replace(ESPACIOS, " ").trim();
}

function recortar(limpia: string, max: number): string {
  const puntos = Array.from(limpia);
  if (puntos.length <= max) return limpia;
  return `${puntos.slice(0, Math.max(0, max - 1)).join("").trimEnd()}…`;
}

// H-028-2-6 (CA-7): lo que un cliente de correo convertiría en enlace dentro de un texto de usuario. Se neutraliza de más, nunca de
// menos: todo punto pegado a algo y seguido de dos letras (`ejemplo.com`, `www.x`, `a.b.example`), el punto de `www.`, los dos puntos de
// `esquema://` y los de los esquemas que se enlazan sin `//` (`mailto:`, `javascript:`…). Un punto entre siglas o cifras (`S.A.C.`,
// `E.I.R.L.`, `2.5`) o seguido de espacio (`Ltda. del`) no se toca. Como solo se agregan corchetes, un recorte posterior tampoco deja
// nada enlazable.
const PUNTO_DOMINIO = /(?<=\S)\.(?=\p{L}{2})/gu;
const PUNTO_WWW = /(?<![\p{L}\p{N}])(www)\./giu;
const DOS_PUNTOS_ESQUEMA = /:(?=\/\/)/gu;
const ESQUEMA_SIN_BARRAS = /(?<![\p{L}\p{N}+.-])(mailto|javascript|vbscript|data|file|tel|sms|callto|news|urn|blob):(?=\S)/giu;

function neutralizarEnlaces(s: string): string {
  return s
    .replace(DOS_PUNTOS_ESQUEMA, "[:]")
    .replace(ESQUEMA_SIN_BARRAS, "$1[:]")
    .replace(PUNTO_WWW, "$1[.]")
    .replace(PUNTO_DOMINIO, "[.]");
}

/**
 * Texto de usuario (razón social, estudio, categoría, recurso) para el correo: `limpiarLinea` y, antes del recorte a `max`, lo que
 * parezca URL o dominio queda neutralizado y legible (`www[.]ejemplo[.]com`, `http[:]//ejemplo[.]com`): los únicos enlaces del correo
 * son los de la app. Un texto sin URL ni dominio sale igual que con `limpiarLinea`. Interno al módulo (no se exporta del índice).
 */
export function lineaUsuario(s: string, max: number): string {
  return recortar(neutralizarEnlaces(sinControles(s)), max);
}

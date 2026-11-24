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
  const limpia = s.replace(SALTOS, " ").replace(INVISIBLES, "").replace(ESPACIOS, " ").trim();
  const puntos = Array.from(limpia);
  if (puntos.length <= max) return limpia;
  return `${puntos.slice(0, Math.max(0, max - 1)).join("").trimEnd()}…`;
}

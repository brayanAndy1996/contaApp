// Spec 023 (D-4, D-9; H-023-1-3, H-023-1-4): saneo de lo que entrega el portal SOL antes de guardarlo. PostgreSQL no admite NUL en
// `text` y los CHECK de 0054 acotan los ids a 1..64 caracteres: un dato así no debe tumbar la captura ni la apertura.

/** Controles, formato (bidi, ancho cero) y sustitutos sueltos. */
const INVISIBLES = /[\p{Cc}\p{Cf}\p{Cs}]/gu;
/** Saltos y tabuladores: separan palabras, así que pasan a espacio antes de quitar el resto. */
const SEPARADORES = /[\t\n\v\f\r\u0085\u2028\u2029]/g;

/** Largo máximo de un id de SUNAT (mensaje o adjunto) en puntos de código (CHECK de 0054). */
export const LARGO_MAXIMO_ID_SUNAT = 64;

/** Quita NUL, controles, caracteres de formato y sustitutos sueltos (misma regla que el nombre de un adjunto). */
export function quitarInvisibles(texto: string): string {
  return texto.replace(INVISIBLES, "");
}

/**
 * Asunto, remitente, id o código de tipo del listado del portal, listo para insertar: los saltos y tabuladores pasan a espacio,
 * el resto de invisibles se quita y se recortan los extremos. No corta el largo (eso lo hace quien conoce la columna).
 */
export function sanearTextoPortal(texto: string): string {
  return quitarInvisibles(texto.replace(SEPARADORES, " ")).trim();
}

/** Un id de SUNAT que la BD admite tal cual: 1..64 puntos de código y sin NUL. */
export function idSunatValido(id: string): boolean {
  if (id.length === 0 || id.includes("\u0000")) return false;
  return Array.from(id).length <= LARGO_MAXIMO_ID_SUNAT;
}

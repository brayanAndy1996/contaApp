/** El correo normalizado contiene caracteres fuera de ASCII. No lleva el correo (ni parcial). */
export class CorreoNoAsciiError extends Error {
  constructor() {
    super("correo_no_ascii");
    this.name = "CorreoNoAsciiError";
  }
}

/** Solo ASCII (U+0000..U+007F): toda unidad UTF-16 ≤ 0x7F. */
function soloAscii(texto: string): boolean {
  for (let i = 0; i < texto.length; i++) if (texto.charCodeAt(i) > 0x7f) return false;
  return true;
}

/**
 * D10 (spec 004): normalización del correo, en este orden y sin otras transformaciones:
 * `trim` → minúsculas → NFC. Función pura; la BD compara el valor exacto ya normalizado.
 * T16 (decisión del usuario, H-r1b-4): los correos son solo ASCII (dominios internacionales en
 * punycode). Si el resultado tiene algún carácter no ASCII lanza `CorreoNoAsciiError`, porque
 * `toLowerCase` de JS y `lower()` de PostgreSQL difieren fuera de ASCII. Lo mismo exige el CHECK
 * de `usuario.email` (migración 0008).
 */
export function normalizarCorreo(correo: string): string {
  const normalizado = correo.trim().toLowerCase().normalize("NFC");
  if (!soloAscii(normalizado)) throw new CorreoNoAsciiError();
  return normalizado;
}

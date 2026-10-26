/**
 * D10 (spec 004): normalización del correo, en este orden y sin otras transformaciones:
 * `trim` → minúsculas → NFC. Función pura; la BD compara el valor exacto ya normalizado.
 */
export function normalizarCorreo(correo: string): string {
  return correo.trim().toLowerCase().normalize("NFC");
}

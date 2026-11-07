// Clave normalizada de un comprobante (spec 013, D17): `tipo|SERIE|numero`, con la serie en mayúsculas
// ASCII y el número sin ceros a la izquierda. Es la misma normalización de los duplicados de 012 y la
// clave única de `venta` por (cliente, periodo). Pura: no depende del locale ni lanza.

const MINUSCULA_ASCII = /[a-z]/g;
/** Ceros a la izquierda sin dejar el número vacío: «000» → «0». */
const CEROS_IZQUIERDA = /^0+(?=[\s\S])/;

/** Solo a-z: ningún otro carácter cambia (sin locale ni plegado Unicode). */
function mayusculasAscii(s: string): string {
  return s.replace(MINUSCULA_ASCII, (c) => c.toUpperCase());
}

/** Serie normalizada (D17): mayúsculas ASCII; es la que agrupa la correlatividad y la que se guarda. */
export function serieNormalizada(serie: string): string {
  return mayusculasAscii(serie);
}

/** `claveNormalizada("03", "b001", "00291")` → `"03|B001|291"`. El tipo no se toca. */
export function claveNormalizada(tipo: string, serie: string, numero: string): string {
  return `${tipo}|${mayusculasAscii(serie)}|${numero.replace(CEROS_IZQUIERDA, "")}`;
}

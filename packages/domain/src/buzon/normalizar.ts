// Spec 023 (D-7, CA-5): normalización del asunto para clasificar. Lineal, sin retroceso.

/** Homoglifos cirílicos y griegos (ya en minúsculas) → latín. Mapa cerrado. */
const HOMOGLIFOS: ReadonlyMap<string, string> = new Map([
  // Cirílico
  ["а", "a"],
  ["в", "b"],
  ["е", "e"],
  ["һ", "h"],
  ["і", "i"],
  ["ј", "j"],
  ["к", "k"],
  ["м", "m"],
  ["н", "h"],
  ["о", "o"],
  ["р", "p"],
  ["с", "c"],
  ["ѕ", "s"],
  ["т", "t"],
  ["у", "y"],
  ["х", "x"],
  ["ԁ", "d"],
  ["ӏ", "l"],
  ["ԛ", "q"],
  ["ԝ", "w"],
  // Griego
  ["α", "a"],
  ["β", "b"],
  ["ε", "e"],
  ["η", "n"],
  ["ι", "i"],
  ["κ", "k"],
  ["ν", "v"],
  ["ο", "o"],
  ["ρ", "p"],
  ["τ", "t"],
  ["υ", "u"],
  ["χ", "x"],
  ["ω", "w"],
  ["ϲ", "c"],
]);

const MARCAS = /\p{M}/gu;
const ESPACIOS = /\s/gu;
/** Controles, formato (bidi, ancho cero) y sustitutos sueltos: fuera sin dejar hueco. */
const INVISIBLES = /[\p{Cc}\p{Cf}\p{Cs}]/gu;
const LETRA_O_DIGITO = /[\p{L}\p{N}]/u;

/**
 * NFKD sin marcas, minúsculas, controles y bidi fuera, homoglifos cirílicos y griegos a latín,
 * puntuación de abreviaturas fuera ("R.D." → "rd"), espacios colapsados y recortados.
 */
export function normalizarAsunto(asunto: string): string {
  const base = asunto
    .normalize("NFKD")
    .toLowerCase()
    .replace(MARCAS, "")
    .replace(ESPACIOS, " ")
    .replace(INVISIBLES, "");
  let salida = "";
  let espacio = false;
  for (const caracter of base) {
    if (caracter === ".") continue;
    const c = HOMOGLIFOS.get(caracter) ?? caracter;
    if (LETRA_O_DIGITO.test(c)) {
      if (espacio && salida.length > 0) salida += " ";
      espacio = false;
      salida += c;
    } else {
      espacio = true;
    }
  }
  return salida;
}

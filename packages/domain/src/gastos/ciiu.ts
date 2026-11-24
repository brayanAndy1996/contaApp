// Spec 027 (R-3 S2 y S4, R-13; plan, Contratos: domain `ciiu.ts`): clase CIIU rev. 4 de 4 dígitos, su sección por división y su
// grupo de 3 dígitos. Puro: sin IO ni tablas externas.

export type SeccionCiiu =
  | "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I" | "J" | "K"
  | "L" | "M" | "N" | "O" | "P" | "Q" | "R" | "S" | "T" | "U";

const CLASE = /^[0-9]{4}$/;

/** [primera división, última división, sección] (rev. 4). Las divisiones fuera de estos rangos no tienen sección. */
const SECCIONES: readonly (readonly [number, number, SeccionCiiu])[] = Object.freeze([
  [1, 3, "A"], [5, 9, "B"], [10, 33, "C"], [35, 35, "D"], [36, 39, "E"], [41, 43, "F"], [45, 47, "G"],
  [49, 53, "H"], [55, 56, "I"], [58, 63, "J"], [64, 66, "K"], [68, 68, "L"], [69, 75, "M"], [77, 82, "N"],
  [84, 84, "O"], [85, 85, "P"], [86, 88, "Q"], [90, 93, "R"], [94, 96, "S"], [97, 98, "T"], [99, 99, "U"],
] as const);

/** S2: clases de consumo personal (lista base del plan). */
export const RUBROS_CONSUMO_PERSONAL: readonly string[] = Object.freeze([
  "4722", "4723", "4761", "4762", "4763", "4764", "4771", "4772", "5610", "5630", "5914", "9200", "9311", "9321", "9329", "9602",
]);

/** S4: comercio minorista (división 47) o restaurante y bar (grupos 561 y 563). */
const DIVISION_MINORISTA = "47";
const GRUPOS_RESTAURANTE: readonly string[] = Object.freeze(["561", "563"]);

export function esClaseCiiu(x: unknown): x is string {
  return typeof x === "string" && CLASE.test(x);
}

/** Sección (A–U) por la división de la clase; clase inválida o división sin sección → null. */
export function seccionCiiu(clase: string): SeccionCiiu | null {
  if (!esClaseCiiu(clase)) return null;
  const division = Number(clase.slice(0, 2));
  for (const [desde, hasta, seccion] of SECCIONES) if (division >= desde && division <= hasta) return seccion;
  return null;
}

/** Los 3 primeros dígitos de una clase válida; si no, null. */
export function grupoCiiu(clase: string): string | null {
  return esClaseCiiu(clase) ? clase.slice(0, 3) : null;
}

export function esRubroConsumoPersonal(clase: string): boolean {
  return esClaseCiiu(clase) && RUBROS_CONSUMO_PERSONAL.includes(clase);
}

export function esMinoristaORestaurante(clase: string): boolean {
  if (!esClaseCiiu(clase)) return false;
  return clase.startsWith(DIVISION_MINORISTA) || GRUPOS_RESTAURANTE.includes(clase.slice(0, 3));
}

// Spec 027 (U-3; plan, Contratos: domain `categorias.ts`): las 6 categorías de gasto no deducible. Se conservan los códigos de 011.
export const CATEGORIAS_GND = Object.freeze([
  "calzado-ropa",
  "juguetes",
  "entretenimiento",
  "alimentos-personales",
  "cuidado-personal",
  "utiles-escolares",
] as const);

export type CategoriaGnd = (typeof CATEGORIAS_GND)[number];

export function esCategoriaGnd(x: unknown): x is CategoriaGnd {
  return typeof x === "string" && (CATEGORIAS_GND as readonly string[]).includes(x);
}

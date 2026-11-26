// Spec 027 (R-13, D-6; plan, Contratos: domain `matriz.ts`): categorías permitidas por la sección CIIU del cliente y su ajuste.
import { CATEGORIAS_GND } from "./categorias";
import type { CategoriaGnd } from "./categorias";
import { seccionCiiu } from "./ciiu";
import type { SeccionCiiu } from "./ciiu";

/** Base por sección (D-6: C y G ninguna; el estudio agrega por cliente las que vende o fabrica). Las secciones ausentes, ninguna. */
export const MATRIZ_BASE: Readonly<Partial<Record<SeccionCiiu, readonly CategoriaGnd[]>>> = Object.freeze({
  I: Object.freeze(["alimentos-personales"] as const),
  P: Object.freeze(["utiles-escolares", "juguetes"] as const),
  Q: Object.freeze(["cuidado-personal"] as const),
  R: Object.freeze(["entretenimiento", "juguetes", "alimentos-personales"] as const),
  S: Object.freeze(["cuidado-personal"] as const),
});

export interface AjusteCategorias {
  readonly permitidas: readonly string[];
  readonly quitadas: readonly string[];
}

/** Base de la sección del cliente; sin CIIU, las 6 (nada está prohibido). Una clase sin sección: ninguna. */
export function categoriasBase(ciiuCliente: string | null): readonly string[] {
  if (ciiuCliente === null) return CATEGORIAS_GND;
  const seccion = seccionCiiu(ciiuCliente);
  return (seccion === null ? undefined : MATRIZ_BASE[seccion]) ?? [];
}

/** (base ∪ permitidas) − quitadas: el ajuste prevalece sobre la base y quitar gana sobre permitir (R-13). No muta el ajuste. */
export function categoriasPermitidas(ciiuCliente: string | null, ajuste: AjusteCategorias): ReadonlySet<string> {
  const salida = new Set<string>([...categoriasBase(ciiuCliente), ...ajuste.permitidas]);
  for (const c of ajuste.quitadas) salida.delete(c);
  return salida;
}

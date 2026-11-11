import type { Autor } from "@contapp/shared";

// Autor con nombre (spec 017, D-12; CA-13). El backend resuelve el nombre; aquí solo se arma el texto: «Nombre»,
// «Nombre (inactivo)» (miembro desactivado) o «Usuario desconocido» (id que no es miembro del estudio).

export type { Autor };

export const MENSAJES_AUTOR = {
  desconocido: "Usuario desconocido",
  inactivo: (nombre: string) => `${nombre} (inactivo)`,
} as const;

/** Texto del autor. Sin `autor` (o con `nombre: null`) es «Usuario desconocido»; nunca se muestra el id. */
export function etiquetaAutor(autor: Autor | null | undefined): string {
  if (!autor || autor.nombre === null) return MENSAJES_AUTOR.desconocido;
  return autor.activo ? autor.nombre : MENSAJES_AUTOR.inactivo(autor.nombre);
}

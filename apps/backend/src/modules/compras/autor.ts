// Autor con nombre (spec 017, D-12, CA-13): une los ids de usuario de una respuesta con `resolverAutores` en UNA consulta por
// respuesta, dentro de la transacción de quien llama. El id se conserva en la respuesta; `autor` es aditivo.
import { resolverAutores, type Tx } from "@contapp/db";
import type { Autor } from "@contapp/shared";

export type Autores = ReadonlyMap<string, Autor>;

/** Resuelve de una vez los ids no nulos y repetidos de una respuesta. */
export async function autoresDe(tx: Tx, ids: readonly (string | null)[]): Promise<Autores> {
  const validos = ids.filter((id): id is string => id !== null);
  return resolverAutores(tx, validos);
}

/** El autor de un id (`null` si nadie lo marcó). Un id que no se resolvió es un desconocido, nunca un hueco. */
export function autorDe(autores: Autores, id: string | null): Autor | null {
  if (id === null) return null;
  return autores.get(id) ?? { id, nombre: null, activo: false };
}

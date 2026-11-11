// Autor con nombre (spec 017, D-12, CA-13). Se resuelve por `membresia` del MISMO estudio unida a `usuario`: un id que no es
// miembro del estudio da `nombre: null` y `activo: false` (nunca el nombre de un usuario ajeno); un miembro desactivado conserva su
// nombre con `activo: false`. Todo con la `tx` de withTenant (la RLS de membresia limita al estudio).
import { consultar, type TxConsulta } from "./errores";

export interface AutorResuelto {
  id: string;
  nombre: string | null;
  activo: boolean;
}

const SQL_AUTORES = `select m.usuario_id, u.nombre, m.desactivada_en is null as activo
  from membresia m join usuario u on u.id = m.usuario_id
 where m.usuario_id = any($1::uuid[])`;

/** Un mapa con una entrada por cada id distinto pedido (la lista vacía da un mapa vacío). */
export async function resolverAutores(tx: TxConsulta, ids: readonly string[]): Promise<Map<string, AutorResuelto>> {
  const unicos = [...new Set(ids)];
  const resultado = new Map<string, AutorResuelto>(unicos.map((id) => [id, { id, nombre: null, activo: false }]));
  if (unicos.length === 0) return resultado;
  for (const f of await consultar(tx, SQL_AUTORES, [unicos])) {
    resultado.set(f.usuario_id, { id: f.usuario_id, nombre: f.nombre, activo: f.activo === true });
  }
  return resultado;
}

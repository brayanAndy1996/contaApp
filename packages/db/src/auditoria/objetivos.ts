// Usuario afectado por una acción de auditoría (spec 017, P-4, D-12). Las filas de `miembro.*` guardan el id de la MEMBRESÍA
// (`entidad_id`) y las de `invitacion.*` el de la INVITACIÓN; ninguna lleva el id del usuario. Aquí se resuelve cada id a su
// usuario, por lote y con la `tx` de withTenant (la RLS limita a membresías e invitaciones del estudio). De la invitación solo se
// lee `aceptada_por`: el correo (D-5) no se consulta. Lo que ya no existe (membresía eliminada) o aún no tiene usuario
// (invitación sin aceptar) no aparece en el mapa.
import { consultar, type TxConsulta } from "../acceso/errores";

const SQL_MEMBRESIAS = `select id, usuario_id from membresia where id = any($1::uuid[])`;
const SQL_INVITACIONES = `select id, aceptada_por from invitacion where id = any($1::uuid[]) and aceptada_por is not null`;

export interface UsuariosDeEntidades {
  /** id de membresía -> id de usuario. */
  membresias: Map<string, string>;
  /** id de invitación -> id del usuario que la aceptó. */
  invitaciones: Map<string, string>;
}

export async function resolverUsuariosDeEntidades(
  tx: TxConsulta,
  ids: { membresias: readonly string[]; invitaciones: readonly string[] },
): Promise<UsuariosDeEntidades> {
  const resultado: UsuariosDeEntidades = { membresias: new Map(), invitaciones: new Map() };
  const membresias = [...new Set(ids.membresias)];
  const invitaciones = [...new Set(ids.invitaciones)];
  if (membresias.length > 0) {
    for (const f of await consultar(tx, SQL_MEMBRESIAS, [membresias])) resultado.membresias.set(f.id, f.usuario_id);
  }
  if (invitaciones.length > 0) {
    for (const f of await consultar(tx, SQL_INVITACIONES, [invitaciones])) resultado.invitaciones.set(f.id, f.aceptada_por);
  }
  return resultado;
}

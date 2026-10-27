// Asignaciones de clientes (spec 005, D6, CA-7, CA-8). Con la `tx` de withTenant (RLS). Todo o nada:
// se bloquean los clientes (ORDER BY id FOR NO KEY UPDATE, así dos cambios del mismo cliente se serializan) y
// las membresías (FOR SHARE), se comprueba el lote completo y solo entonces se escribe.
// Rechazos: null = algún cliente o usuario no existe o no es del estudio (-> 404); AccesoReglaError =
// miembro desactivado ('miembro_no_asignable') o falta `anterior` habiendo otro responsable ('anterior_requerido').
// La regla D18 (puede ser responsable) la aplica el servicio sobre el rol de bloquearMiembro.
import { AccesoReglaError, consultar, type TxConsulta } from "./errores";

export type TipoAsignacion = "responsable" | "colaborador";
/** Qué hacer con el responsable previo al elegir otro. */
export type Anterior = "colaborador" | "retirar";

export interface Asignar {
  clienteId: string;
  usuarioId: string;
  tipo: TipoAsignacion;
  anterior?: Anterior;
}

export interface AsignarPorUsuario {
  usuarioId: string;
  clienteIds: string[];
  tipo: TipoAsignacion;
  anterior?: Anterior;
}

export interface AsignarPorCliente {
  clienteId: string;
  /** Se asignan como colaboradores (un responsable existente lo sigue siendo). */
  usuarioIds: string[];
}

export interface AsignacionListada {
  usuarioId: string;
  nombre: string;
  tipo: TipoAsignacion;
}

const SQL_BLOQUEAR_CLIENTES =
  "select id from cliente where id = any($1::uuid[]) order by id for no key update";

const SQL_BLOQUEAR_MIEMBROS = `select usuario_id, desactivada_en is null as activo
  from membresia where usuario_id = any($1::uuid[]) order by usuario_id for share`;

const SQL_OTROS_RESPONSABLES = `select 1 from asignacion
 where cliente_id = any($1::uuid[]) and usuario_id <> $2::uuid and tipo = 'responsable' limit 1`;

const SQL_ANTERIOR_A_COLABORADOR = `update asignacion set tipo = 'colaborador', updated_at = now()
 where cliente_id = any($1::uuid[]) and usuario_id <> $2::uuid and tipo = 'responsable'`;

const SQL_ANTERIOR_RETIRAR = `delete from asignacion
 where cliente_id = any($1::uuid[]) and usuario_id <> $2::uuid and tipo = 'responsable'`;

const SQL_INSERTAR_POR_USUARIO = `insert into asignacion (cliente_id, usuario_id, tipo)
  select c, $2::uuid, $3 from unnest($1::uuid[]) c
  on conflict (tenant_id, cliente_id, usuario_id) do update set tipo = excluded.tipo, updated_at = now()`;

const SQL_INSERTAR_POR_CLIENTE = `insert into asignacion (cliente_id, usuario_id, tipo)
  select $1::uuid, u, 'colaborador' from unnest($2::uuid[]) u
  on conflict (tenant_id, cliente_id, usuario_id) do nothing`;

const SQL_LISTAR = `select a.usuario_id, u.nombre, a.tipo
  from asignacion a join usuario u on u.id = a.usuario_id
 where a.cliente_id = $1::uuid
 order by a.tipo = 'responsable' desc, u.nombre, a.usuario_id`;

const SQL_RETIRAR =
  "delete from asignacion where cliente_id = $1::uuid and usuario_id = $2::uuid returning id";

const unicos = (xs: string[]): string[] => [...new Set(xs)];

/** Bloquea todos los clientes; false si alguno no existe o no es del estudio. */
async function bloquearClientes(
  tx: TxConsulta,
  clienteIds: string[],
): Promise<boolean> {
  return (
    (await consultar(tx, SQL_BLOQUEAR_CLIENTES, [clienteIds])).length ===
    clienteIds.length
  );
}

/** Bloquea las membresías: null si alguna no es del estudio; AccesoReglaError si alguna está desactivada. */
async function bloquearMiembros(
  tx: TxConsulta,
  usuarioIds: string[],
): Promise<true | null> {
  const filas = await consultar(tx, SQL_BLOQUEAR_MIEMBROS, [usuarioIds]);
  if (filas.length !== usuarioIds.length) return null;
  if (filas.some((f) => f.activo !== true))
    throw new AccesoReglaError("miembro_no_asignable");
  return true;
}

/** Asigna un usuario a varios clientes con el mismo tipo (todo o nada). */
async function aplicarPorUsuario(
  tx: TxConsulta,
  a: AsignarPorUsuario,
): Promise<number | null> {
  const clienteIds = unicos(a.clienteIds);
  if (!(await bloquearClientes(tx, clienteIds))) return null;
  if ((await bloquearMiembros(tx, [a.usuarioId])) === null) return null;
  if (
    a.tipo === "responsable" &&
    (await consultar(tx, SQL_OTROS_RESPONSABLES, [clienteIds, a.usuarioId]))
      .length > 0
  ) {
    if (a.anterior === undefined)
      throw new AccesoReglaError("anterior_requerido");
    await consultar(
      tx,
      a.anterior === "retirar"
        ? SQL_ANTERIOR_RETIRAR
        : SQL_ANTERIOR_A_COLABORADOR,
      [clienteIds, a.usuarioId],
    );
  }
  await consultar(tx, SQL_INSERTAR_POR_USUARIO, [
    clienteIds,
    a.usuarioId,
    a.tipo,
  ]);
  return clienteIds.length;
}

/** Asignaciones de un cliente (responsable primero). */
export async function listarAsignaciones(
  tx: TxConsulta,
  clienteId: string,
): Promise<AsignacionListada[]> {
  return (await consultar(tx, SQL_LISTAR, [clienteId])).map((f) => ({
    usuarioId: f.usuario_id,
    nombre: f.nombre,
    tipo: f.tipo,
  }));
}

/** Asigna (o cambia el tipo de) un usuario en un cliente; devuelve las asignaciones del cliente, o null. */
export async function asignar(
  tx: TxConsulta,
  a: Asignar,
): Promise<AsignacionListada[] | null> {
  const n = await aplicarPorUsuario(tx, {
    usuarioId: a.usuarioId,
    clienteIds: [a.clienteId],
    tipo: a.tipo,
    ...(a.anterior === undefined ? {} : { anterior: a.anterior }),
  });
  return n === null ? null : listarAsignaciones(tx, a.clienteId);
}

/** Retira la asignación; null si no existía. */
export async function retirar(
  tx: TxConsulta,
  r: { clienteId: string; usuarioId: string },
): Promise<true | null> {
  return (await consultar(tx, SQL_RETIRAR, [r.clienteId, r.usuarioId])).length >
    0
    ? true
    : null;
}

/** Lote: un usuario en varios clientes (1..500). */
export async function asignarPorUsuario(
  tx: TxConsulta,
  a: AsignarPorUsuario,
): Promise<{ asignados: number } | null> {
  const n = await aplicarPorUsuario(tx, a);
  return n === null ? null : { asignados: n };
}

/** Lote: varios usuarios como colaboradores de un cliente (1..500). */
export async function asignarPorCliente(
  tx: TxConsulta,
  a: AsignarPorCliente,
): Promise<{ asignados: number } | null> {
  const usuarioIds = unicos(a.usuarioIds);
  if (!(await bloquearClientes(tx, [a.clienteId]))) return null;
  if ((await bloquearMiembros(tx, usuarioIds)) === null) return null;
  await consultar(tx, SQL_INSERTAR_POR_CLIENTE, [a.clienteId, usuarioIds]);
  return { asignados: usuarioIds.length };
}

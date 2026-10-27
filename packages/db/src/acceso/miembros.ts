// Miembros del estudio (spec 005): rol, estado (D9) y transiciones. Todo con la `tx` de withTenant (la RLS
// limita al estudio del contexto). El trigger membresia_ultimo_dueno (0012) rechaza dejar el estudio sin Dueño
// activo: sale como AccesoRepoError con codigo P0001 (-> 409 ultimo_dueno).
import { consultar, type Fila, type TxConsulta } from "./errores";

export type RolMiembro =
  "dueno" | "admin" | "contador" | "asistente" | "lectura";

/** Roles del catálogo (D21); el CHECK de la BD es el mismo. */
export const ROLES_MIEMBRO: readonly RolMiembro[] = Object.freeze([
  "dueno",
  "admin",
  "contador",
  "asistente",
  "lectura",
]);

export interface MiembroActual {
  usuarioId: string;
  rol: RolMiembro;
}

export interface MiembroEstado {
  usuarioId: string;
  rol: RolMiembro;
  activo: boolean;
}

export interface MiembroListado extends MiembroEstado {
  nombre: string;
  correo: string;
}

const SQL_ACTUAL =
  "select usuario_id, rol from membresia where usuario_id = $1::uuid and desactivada_en is null";

// `rol = any($1)`: solo roles del catálogo (defensa en profundidad; el CHECK ya lo garantiza).
const SQL_LISTAR = `select m.usuario_id, u.nombre, u.email as correo, m.rol, m.desactivada_en is null as activo
  from membresia m join usuario u on u.id = m.usuario_id
 where m.rol = any($1::text[])
 order by u.nombre, m.usuario_id`;

const SQL_BLOQUEAR = `select usuario_id, rol, desactivada_en is null as activo
  from membresia where usuario_id = $1::uuid for update`;

// Una sola sentencia: PostgreSQL bloquea las filas en el orden del ORDER BY (LockRows sobre Sort).
const SQL_BLOQUEAR_VARIOS = `select usuario_id, rol, desactivada_en is null as activo
  from membresia where usuario_id = any($1::uuid[]) order by usuario_id for update`;

const SQL_CAMBIAR_ROL = `update membresia set rol = $2, updated_at = now() where usuario_id = $1::uuid
  returning usuario_id, rol, desactivada_en is null as activo`;

// D18: al pasar a un rol sin `sire.clasificar`, sus filas de responsable quedan como colaborador.
const SQL_RESPONSABLE_A_COLABORADOR = `update asignacion set tipo = 'colaborador', updated_at = now()
 where usuario_id = $1::uuid and tipo = 'responsable' and $2::boolean`;

const SQL_DESACTIVAR = `update membresia set desactivada_en = coalesce(desactivada_en, now()), updated_at = now()
 where usuario_id = $1::uuid returning usuario_id, rol, desactivada_en is null as activo`;

// D19, RF-027: desactivar retira todas sus asignaciones (responsable y colaborador).
const SQL_BORRAR_ASIGNACIONES =
  "delete from asignacion where usuario_id = $1::uuid";

const SQL_REACTIVAR = `update membresia set desactivada_en = null, updated_at = now()
 where usuario_id = $1::uuid returning usuario_id, rol, desactivada_en is null as activo`;

const estado = (f: Fila | undefined): MiembroEstado | null =>
  f === undefined
    ? null
    : { usuarioId: f.usuario_id, rol: f.rol, activo: f.activo === true };

/** Rol de la membresía ACTIVA del usuario en el estudio (D3), o null. */
export async function miembroActual(
  tx: TxConsulta,
  usuarioId: string,
): Promise<MiembroActual | null> {
  const f = (await consultar(tx, SQL_ACTUAL, [usuarioId]))[0];
  return f === undefined ? null : { usuarioId: f.usuario_id, rol: f.rol };
}

/** Miembros del estudio, activos y desactivados. */
export async function listarMiembros(
  tx: TxConsulta,
): Promise<MiembroListado[]> {
  const filas = await consultar(tx, SQL_LISTAR, [ROLES_MIEMBRO]);
  return filas.map((f) => ({
    usuarioId: f.usuario_id,
    nombre: f.nombre,
    correo: f.correo,
    rol: f.rol,
    activo: f.activo === true,
  }));
}

/** Bloquea la membresía (FOR UPDATE), también si está desactivada; null si no es del estudio. */
export async function bloquearMiembro(
  tx: TxConsulta,
  usuarioId: string,
): Promise<MiembroEstado | null> {
  return estado((await consultar(tx, SQL_BLOQUEAR, [usuarioId]))[0]);
}

/**
 * Orden global de bloqueo de 005 (plan, Decisiones: "Orden de bloqueo"): primero TODAS las membresías que la
 * acción toca (actor y objetivos) en UNA sentencia `ORDER BY usuario_id FOR UPDATE`, luego los clientes por id,
 * luego las filas de asignación/invitación. Devuelve las que son del estudio (también desactivadas), por ID en
 * minúsculas; los IDs se normalizan (minúsculas, sin repetir) antes de bloquear.
 */
export async function bloquearMiembros(
  tx: TxConsulta,
  usuarioIds: readonly string[],
): Promise<Map<string, MiembroEstado>> {
  const ids = [...new Set(usuarioIds.map((id) => id.toLowerCase()))];
  const filas = await consultar(tx, SQL_BLOQUEAR_VARIOS, [ids]);
  const m = new Map<string, MiembroEstado>();
  for (const f of filas) m.set(f.usuario_id, estado(f) as MiembroEstado);
  return m;
}

/**
 * Cambia el rol. Con `responsableAColaborador` (el servicio lo decide con `puedeSerResponsable`, D18) sus filas
 * de responsable pasan a colaborador en la misma transacción.
 */
export async function cambiarRol(
  tx: TxConsulta,
  usuarioId: string,
  rol: RolMiembro,
  responsableAColaborador?: boolean,
): Promise<MiembroEstado | null> {
  const m = estado((await consultar(tx, SQL_CAMBIAR_ROL, [usuarioId, rol]))[0]);
  await consultar(tx, SQL_RESPONSABLE_A_COLABORADOR, [
    usuarioId,
    m !== null && responsableAColaborador === true,
  ]);
  return m;
}

/** Fija desactivada_en (D9) y borra todas sus asignaciones (D19). */
export async function desactivar(
  tx: TxConsulta,
  usuarioId: string,
): Promise<MiembroEstado | null> {
  const m = estado((await consultar(tx, SQL_DESACTIVAR, [usuarioId]))[0]);
  await consultar(tx, SQL_BORRAR_ASIGNACIONES, [usuarioId]);
  return m;
}

/** Limpia desactivada_en; conserva el rol y NO devuelve las asignaciones (D19). */
export async function reactivar(
  tx: TxConsulta,
  usuarioId: string,
): Promise<MiembroEstado | null> {
  return estado((await consultar(tx, SQL_REACTIVAR, [usuarioId]))[0]);
}

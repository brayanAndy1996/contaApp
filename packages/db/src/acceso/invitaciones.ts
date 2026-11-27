// Invitaciones del estudio (spec 005, D7): solo el SHA-256 del token se guarda y nada de lo que devuelven estos
// repositorios lleva el token ni su hash (CA-14). Vencen a las 72 h. Con la `tx` de withTenant (RLS).
// reenviar/revocar devuelven null si la invitación no existe, es de otro estudio o ya está aceptada o revocada.
// Spec 030 (D2): `rol = 'propio'` con `rol_id`; el disparador de 0082 exige que quien invita contenga el rol (42501) y la FK compuesta
// rechaza un rol de otro estudio o inexistente (23503).
import { consultar, type Fila, type TxConsulta } from "./errores";
import { ROLES_MIEMBRO, type RolMiembro } from "./miembros";

export interface NuevaInvitacion {
  /** Correo ya normalizado (normalizarCorreo de 004); el CHECK es el de usuario.email. */
  correo: string;
  rol: RolMiembro;
  /** Rol propio (solo con `rol = 'propio'`; con uno de sistema se ignora). */
  rolId?: string | null;
  invitadoPor: string;
  tokenHash: Buffer;
}

/** Lo que quien invitó aún puede otorgar: un rol de sistema o un rol propio por su id (030). */
export type RolQueConserva = RolMiembro | { rolId: string };

export interface InvitacionListada {
  id: string;
  correo: string;
  rol: RolMiembro;
  /** Rol propio (null en los de sistema). */
  rolId: string | null;
  rolNombre: string | null;
  invitadoPor: { usuarioId: string; nombre: string };
  creadaEn: Date;
  venceEn: Date;
  vencida: boolean;
}

// Columnas públicas de una invitación (nunca token_hash) con el nombre de quien invita.
const COLUMNAS = `i.id, i.correo, i.rol, i.rol_id, (select r.nombre from rol r where r.id = i.rol_id) as rol_nombre,
       i.invitado_por, u.nombre as invitado_por_nombre, i.creada_en, i.vence_en, i.vence_en <= now() as vencida`;

// Una vencida pendiente del mismo correo se revoca antes de emitir la nueva (libera el índice único parcial).
// D4 (030, T13): toda sentencia sobre `invitacion` toma antes el advisory `acceso.roles:<estudio>` (disparador por sentencia de 0085,
// el mismo que toma bloquearMiembros), así bloquear esta fila y luego el rol (FK y disparador de asignación al insertar) no se cruza
// con rol_eliminar (advisory -> membresías -> rol -> invitaciones).
const SQL_REVOCAR_VENCIDAS = `update invitacion set revocada_en = now()
 where correo = $1 and aceptada_en is null and revocada_en is null and vence_en <= now()`;

const SQL_CREAR = `with i as (
  insert into invitacion (correo, rol, rol_id, invitado_por, token_hash, vence_en)
  values ($1, $2, $5::uuid, $3::uuid, $4, now() + interval '72 hours')
  returning id, correo, rol, rol_id, invitado_por, creada_en, vence_en
)
select ${COLUMNAS} from i left join usuario u on u.id = i.invitado_por`;

const SQL_LISTAR = `select ${COLUMNAS}
  from invitacion i left join usuario u on u.id = i.invitado_por
 where i.aceptada_en is null and i.revocada_en is null and i.rol = any($1::text[])
 order by i.creada_en, i.id`;

const SQL_REENVIAR = `with i as (
  update invitacion set token_hash = $2, vence_en = now() + interval '72 hours'
   where id = $1::uuid and aceptada_en is null and revocada_en is null
  returning id, correo, rol, rol_id, invitado_por, creada_en, vence_en
)
select ${COLUMNAS} from i left join usuario u on u.id = i.invitado_por`;

const SQL_REVOCAR = `with i as (
  update invitacion set revocada_en = now()
   where id = $1::uuid and aceptada_en is null and revocada_en is null
  returning id, correo, rol, rol_id, invitado_por, creada_en, vence_en
)
select ${COLUMNAS} from i left join usuario u on u.id = i.invitado_por`;

// H-005-1b-1 (D8): al desactivar o cambiar de rol a quien invitó, sus pendientes (vivas o vencidas) cuyo rol ya
// no podría otorgar quedan revocadas. `$2` = lo que conserva (vacío al desactivarlo): claves de rol de sistema e ids de roles propios
// (030). Una invitación a un rol propio solo se conserva si su `rol_id` está en la lista ('propio' a secas no conserva ninguna).
const SQL_REVOCAR_PENDIENTES_DE = `update invitacion set revocada_en = now()
 where invitado_por = $1::uuid and aceptada_en is null and revocada_en is null
   and not (case when rol = 'propio' then rol_id::text = any($2::text[]) else rol = any($2::text[]) end)
 returning id`;

// T15a (030): nombre ACTUAL del rol propio de una invitación viva, para `POST /invitaciones/consultar`. Solo el nombre (nunca id,
// permisos ni alcance). Con la `tx` de withTenant del estudio que devolvió `auth.invitacion_vigente` (RLS de invitacion y rol por
// app.tenant_id): no alcanza roles de otro estudio. Repite el criterio de vigencia; null si ya no está viva o no es de rol propio.
const SQL_NOMBRE_ROL_PROPIO = `select r.nombre
  from invitacion i join rol r on r.tenant_id = i.tenant_id and r.id = i.rol_id
 where i.token_hash = $1 and i.rol = 'propio' and i.aceptada_en is null and i.revocada_en is null and i.vence_en > now()`;

const invitacion = (f: Fila): InvitacionListada => ({
  id: f.id,
  correo: f.correo,
  rol: f.rol,
  rolId: f.rol_id ?? null,
  rolNombre: f.rol_nombre ?? null,
  invitadoPor: { usuarioId: f.invitado_por, nombre: f.invitado_por_nombre },
  creadaEn: f.creada_en,
  venceEn: f.vence_en,
  vencida: f.vencida === true,
});

const unaONinguna = (filas: Fila[]): InvitacionListada | null =>
  filas.length === 0 ? null : invitacion(filas[0]!);

/** Crea la invitación (72 h). Otra pendiente viva del mismo correo -> AccesoRepoError 23505. */
export async function crearInvitacion(
  tx: TxConsulta,
  n: NuevaInvitacion,
): Promise<InvitacionListada> {
  await consultar(tx, SQL_REVOCAR_VENCIDAS, [n.correo]);
  const filas = await consultar(tx, SQL_CREAR, [
    n.correo,
    n.rol,
    n.invitadoPor,
    n.tokenHash,
    n.rol === "propio" ? (n.rolId ?? null) : null,
  ]);
  return invitacion(filas[0]!);
}

/** Pendientes del estudio (las vencidas con `vencida = true`), sin token ni hash. */
export async function listarInvitaciones(
  tx: TxConsulta,
): Promise<InvitacionListada[]> {
  return (await consultar(tx, SQL_LISTAR, [ROLES_MIEMBRO])).map(invitacion);
}

/** Nuevo token (el anterior deja de valer) y 72 h más. */
export async function reenviar(
  tx: TxConsulta,
  invitacionId: string,
  tokenHashNuevo: Buffer,
): Promise<InvitacionListada | null> {
  return unaONinguna(
    await consultar(tx, SQL_REENVIAR, [invitacionId, tokenHashNuevo]),
  );
}

/** Anula el token. */
export async function revocar(
  tx: TxConsulta,
  invitacionId: string,
): Promise<InvitacionListada | null> {
  return unaONinguna(await consultar(tx, SQL_REVOCAR, [invitacionId]));
}

/**
 * Revoca las invitaciones pendientes emitidas por `usuarioId` cuyo rol no esté en `rolesQueConserva` (los que su
 * nuevo estado aún le permite otorgar; ninguno si se desactiva). Un rol propio se conserva por su id (`{ rolId }`).
 * Devuelve cuántas revocó.
 */
export async function revocarPendientesDe(
  tx: TxConsulta,
  usuarioId: string,
  rolesQueConserva: readonly RolQueConserva[],
): Promise<number> {
  return (
    await consultar(tx, SQL_REVOCAR_PENDIENTES_DE, [
      usuarioId,
      rolesQueConserva.map((r) => (typeof r === "string" ? r : r.rolId.toLowerCase())),
    ])
  ).length;
}

/** T15a (030): nombre actual del rol propio de la invitación viva con ese hash de token; null si no hay. Nunca el hash de vuelta. */
export async function nombreRolPropioDeInvitacion(
  tx: TxConsulta,
  tokenHash: Buffer,
): Promise<string | null> {
  const filas = await consultar(tx, SQL_NOMBRE_ROL_PROPIO, [tokenHash]);
  const nombre: unknown = filas[0]?.nombre;
  return typeof nombre === "string" ? nombre : null;
}

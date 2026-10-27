// Invitaciones del estudio (spec 005, D7): solo el SHA-256 del token se guarda y nada de lo que devuelven estos
// repositorios lleva el token ni su hash (CA-14). Vencen a las 72 h. Con la `tx` de withTenant (RLS).
// reenviar/revocar devuelven null si la invitación no existe, es de otro estudio o ya está aceptada o revocada.
import { consultar, type Fila, type TxConsulta } from "./errores";
import { ROLES_MIEMBRO, type RolMiembro } from "./miembros";

export interface NuevaInvitacion {
  /** Correo ya normalizado (normalizarCorreo de 004); el CHECK es el de usuario.email. */
  correo: string;
  rol: RolMiembro;
  invitadoPor: string;
  tokenHash: Buffer;
}

export interface InvitacionListada {
  id: string;
  correo: string;
  rol: RolMiembro;
  invitadoPor: { usuarioId: string; nombre: string };
  creadaEn: Date;
  venceEn: Date;
  vencida: boolean;
}

// Columnas públicas de una invitación (nunca token_hash) con el nombre de quien invita.
const COLUMNAS = `i.id, i.correo, i.rol, i.invitado_por, u.nombre as invitado_por_nombre, i.creada_en, i.vence_en,
       i.vence_en <= now() as vencida`;

// Una vencida pendiente del mismo correo se revoca antes de emitir la nueva (libera el índice único parcial).
const SQL_REVOCAR_VENCIDAS = `update invitacion set revocada_en = now()
 where correo = $1 and aceptada_en is null and revocada_en is null and vence_en <= now()`;

const SQL_CREAR = `with i as (
  insert into invitacion (correo, rol, invitado_por, token_hash, vence_en)
  values ($1, $2, $3::uuid, $4, now() + interval '72 hours')
  returning id, correo, rol, invitado_por, creada_en, vence_en
)
select ${COLUMNAS} from i left join usuario u on u.id = i.invitado_por`;

const SQL_LISTAR = `select ${COLUMNAS}
  from invitacion i left join usuario u on u.id = i.invitado_por
 where i.aceptada_en is null and i.revocada_en is null and i.rol = any($1::text[])
 order by i.creada_en, i.id`;

const SQL_REENVIAR = `with i as (
  update invitacion set token_hash = $2, vence_en = now() + interval '72 hours'
   where id = $1::uuid and aceptada_en is null and revocada_en is null
  returning id, correo, rol, invitado_por, creada_en, vence_en
)
select ${COLUMNAS} from i left join usuario u on u.id = i.invitado_por`;

const SQL_REVOCAR = `with i as (
  update invitacion set revocada_en = now()
   where id = $1::uuid and aceptada_en is null and revocada_en is null
  returning id, correo, rol, invitado_por, creada_en, vence_en
)
select ${COLUMNAS} from i left join usuario u on u.id = i.invitado_por`;

const invitacion = (f: Fila): InvitacionListada => ({
  id: f.id,
  correo: f.correo,
  rol: f.rol,
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

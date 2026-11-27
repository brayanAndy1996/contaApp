// Roles propios del estudio (spec 030, D1). Todo con la `tx` de withTenant: la RLS limita al estudio del contexto y el actor de las
// funciones es `app.user_id`. La escritura va solo por las funciones de 0082 (`acceso.rol_guardar`, `acceso.rol_eliminar`), que
// aplican U1–U5, U9, la auditoría y el orden de bloqueo de D4; los errores salen como AccesoRepoError con solo el SQLSTATE (CA-14):
// 42501 escalada o sin roles.gestionar, RL001 el rol propio del actor, 22023 combinación (U3), 54000 límite (U9), 23503 en uso (U5),
// 23505 nombre repetido, 23514 CHECK, P0002 rol inexistente o de otro estudio.
import { AccesoRepoError, consultar, type Fila, type TxConsulta } from "./errores";

export type AlcanceRol = "global" | "asignado";

/** Valor de `membresia.rol` / `invitacion.rol` de quien tiene un rol propio (D2). */
const ROL_PROPIO = "propio";

export interface DatosRol {
  /** Sin id crea; con id edita (reemplaza nombre, alcance y permisos). */
  id?: string | null;
  nombre: string;
  alcance: AlcanceRol;
  permisos: readonly string[];
}

export interface RolLeido {
  id: string;
  nombre: string;
  alcance: AlcanceRol;
  /** Ordenados alfabéticamente. */
  permisos: string[];
}

export interface RolListado extends RolLeido {
  /** Miembros activos con el rol. */
  miembros: number;
  /** Invitaciones vigentes (sin aceptar, sin revocar y sin vencer) con el rol. */
  invitaciones: number;
}

export interface UsoRol {
  miembros: number;
  invitaciones: number;
}

export interface ImpactoRol {
  miembros: number;
  clientesSinResponsable: number;
  miembrosSinTotpExigidos: number;
}

// Una sola consulta (sin N+1): permisos con array_agg y conteos por subconsulta, todas por índice (CA-11).
const SQL_LISTAR = `select r.id, r.nombre, r.alcance,
       (select array_agg(p.permiso order by p.permiso) from rol_permiso p where p.rol_id = r.id) as permisos,
       (select count(*) from membresia m where m.rol = $1 and m.rol_id = r.id and m.desactivada_en is null) as miembros,
       (select count(*) from invitacion i
         where i.rol = $1 and i.rol_id = r.id and i.aceptada_en is null and i.revocada_en is null and i.vence_en > now()) as invitaciones
  from rol r
 order by r.nombre_clave, r.id`;

const SQL_LEER = `select r.id, r.nombre, r.alcance,
       (select array_agg(p.permiso order by p.permiso) from rol_permiso p where p.rol_id = r.id) as permisos
  from rol r where r.id = $1::uuid`;

const SQL_GUARDAR = "select acceso.rol_guardar($1::uuid, $2::text, $3::text, $4::text[]) as id";

const SQL_ELIMINAR = "select acceso.rol_eliminar($1::uuid)";

const SQL_USO = `select (select count(*) from membresia m where m.rol_id = $1::uuid and m.desactivada_en is null) as miembros,
       (select count(*) from invitacion i
         where i.rol_id = $1::uuid and i.aceptada_en is null and i.revocada_en is null and i.vence_en > now()) as invitaciones`;

const SQL_IMPACTO =
  "select miembros, clientes_sin_responsable, miembros_sin_totp_exigidos from acceso.rol_impacto($1::uuid, $2::text, $3::text[])";

// Mismo candado que toman `rol_guardar` y `rol_eliminar` (D4: primero este, luego membresías y la fila del rol): reentrante en la
// misma transacción. Sirve para leer-y-escribir sin perder una edición concurrente (PATCH parcial).
const SQL_BLOQUEAR = "select pg_advisory_xact_lock(hashtextextended('acceso.roles:' || current_setting('app.tenant_id', true), 0))";

const numero = (v: unknown): number => Number(v ?? 0);
const ordenados = (v: unknown): string[] => (Array.isArray(v) ? [...(v as string[])].sort() : []);

const leido = (f: Fila): RolLeido => ({
  id: f.id,
  nombre: f.nombre,
  alcance: f.alcance,
  permisos: ordenados(f.permisos),
});

/** Roles propios del estudio con permisos y conteos de uso (los de sistema viven en código). */
export async function listarRoles(tx: TxConsulta): Promise<RolListado[]> {
  const filas = await consultar(tx, SQL_LISTAR, [ROL_PROPIO]);
  return filas.map((f) => ({ ...leido(f), miembros: numero(f.miembros), invitaciones: numero(f.invitaciones) }));
}

/** Un rol propio del estudio, o null (inexistente o de otro estudio). */
export async function leerRol(tx: TxConsulta, id: string): Promise<RolLeido | null> {
  const f = (await consultar(tx, SQL_LEER, [id]))[0];
  return f === undefined ? null : leido(f);
}

/** Crea o edita (con `id`) un rol propio; devuelve su id. */
export async function guardarRol(tx: TxConsulta, datos: DatosRol): Promise<string> {
  const f = (await consultar(tx, SQL_GUARDAR, [datos.id ?? null, datos.nombre, datos.alcance, [...datos.permisos]]))[0];
  if (f === undefined || typeof f.id !== "string") throw new AccesoRepoError("desconocido");
  return f.id;
}

/** Elimina un rol propio libre (U5: en uso -> 23503). */
export async function eliminarRol(tx: TxConsulta, id: string): Promise<void> {
  await consultar(tx, SQL_ELIMINAR, [id]);
}

/** Conteos del 409 `rol_en_uso`: miembros activos e invitaciones vigentes. */
export async function usoRol(tx: TxConsulta, id: string): Promise<UsoRol> {
  const f = (await consultar(tx, SQL_USO, [id]))[0];
  return { miembros: numero(f?.miembros), invitaciones: numero(f?.invitaciones) };
}

/** Efecto de una edición sin aplicarla (U6, U8). */
export async function impactoRol(
  tx: TxConsulta,
  id: string,
  cambio: { alcance: AlcanceRol; permisos: readonly string[] },
): Promise<ImpactoRol> {
  const f = (await consultar(tx, SQL_IMPACTO, [id, cambio.alcance, [...cambio.permisos]]))[0];
  return {
    miembros: numero(f?.miembros),
    clientesSinResponsable: numero(f?.clientes_sin_responsable),
    miembrosSinTotpExigidos: numero(f?.miembros_sin_totp_exigidos),
  };
}

/** Toma el candado de roles del estudio hasta el fin de la transacción (D4: debe ser lo primero que se bloquea). */
export async function bloquearRoles(tx: TxConsulta): Promise<void> {
  await consultar(tx, SQL_BLOQUEAR, []);
}

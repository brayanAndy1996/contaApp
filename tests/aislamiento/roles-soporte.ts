// Soporte de las pruebas de BD de la spec 030 (T1). No es una prueba (no termina en .spec.ts).
//
// CONTRATO DE BD QUE FIJAN LAS PRUEBAS (lo implementa T6 en 0082; ver plan.md#contratos):
//   Tablas   rol(tenant_id, id, nombre, nombre_clave GENERATED, alcance, creado_en, actualizado_en)
//            rol_permiso(tenant_id, rol_id, permiso); membresia.rol_id e invitacion.rol_id; rol admite 'propio'.
//            La siembra de estas pruebas inserta con la conexion administrativa (superusuario): la escritura directa de la app esta cerrada.
//   Funciones (SECURITY DEFINER; actor = app.user_id, estudio = app.tenant_id; se llaman con withTenant de contapp_backend)
//     acceso.rol_guardar(p_id uuid, p_nombre text, p_alcance text, p_permisos text[]) -> uuid   (p_id NULL crea)
//     acceso.rol_eliminar(p_id uuid) -> void
//     acceso.rol_impacto(p_id uuid, p_alcance text, p_permisos text[]) -> (miembros int, clientes_sin_responsable int, miembros_sin_totp_exigidos int)
//     acceso.permisos_membresia(p_tenant uuid, p_usuario uuid) -> (rol_sistema text, permisos text[], alcance text)
//   Errores (SQLSTATE fijo; el repositorio solo conserva el SQLSTATE, CA-14; mensaje fijo, sin ids ni nombres):
//     42501 escalada o actor sin roles.gestionar / sin actor (U1, U2, U4)      RL001 el actor toca el rol que tiene asignado (U2)
//     22023 combinacion invalida (U3)   54000 limite de 20 roles (U9)   23503 rol en uso (U5) o FK   23505 nombre duplicado
//     23514 CHECK (permiso fuera del catalogo, nombre de sistema, nombre mal formado)   P0002 rol inexistente o de otro estudio
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { PERMISOS_ASIGNABLES, REGLAS_U3, type AlcanceRol } from "../../packages/shared/src/acceso/efectivos.casos";
import { EscenarioAcceso, sha256, type InvitacionPrueba } from "./acceso-soporte";
import { crearDb, enRollback, type ContappDb, type ContextoTenant } from "./soporte";

export { PERMISOS_ASIGNABLES, REGLAS_U3 };
export type { AlcanceRol };

/** Codigos que el contrato de 0082 fija (ver el encabezado). */
export const COD = {
  escalada: "42501",
  rolPropio: "RL001",
  combinacion: "22023",
  limite: "54000",
  enUso: "23503",
  duplicado: "23505",
  check: "23514",
  noExiste: "P0002",
  interbloqueo: "40P01",
  serializacion: "40001",
} as const;

/** Un permiso y todos sus requisitos de U3 (transitivos: buzon.atender -> buzon.ver -> clientes.ver). */
export function cierreU3(permisos: readonly string[]): string[] {
  const s = new Set(permisos);
  for (let cambio = true; cambio; ) {
    cambio = false;
    for (const r of REGLAS_U3) {
      if (s.has(r.permiso) && !s.has(r.requiere)) {
        s.add(r.requiere);
        cambio = true;
      }
    }
  }
  return PERMISOS_ASIGNABLES.filter((p) => s.has(p));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- filas de pg sin tipo, como en soporte.ts
export type Res = { ok: true; rows: any[] } | { ok: false; code: string; message: string };
export const codigo = (r: Res): string => (r.ok ? "ok" : r.code);

/** Una sentencia dentro de withTenant (CONFIRMA al terminar bien; si falla, revierte y devuelve el SQLSTATE). */
export async function ejecutar(db: ContappDb, ctx: ContextoTenant, sql: string, valores: unknown[] = []): Promise<Res> {
  try {
    const rows = await db.withTenant(ctx, async (tx) => (await tx.query(sql, valores)).rows);
    return { ok: true, rows };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, code: String(err.code ?? ""), message: String(err.message ?? "") };
  }
}

/** Como `ejecutar`, pero SIEMPRE revierte (para recorrer muchos casos sin dejar filas ni gastar el limite de roles). */
export async function probar(db: ContappDb, ctx: ContextoTenant, sql: string, valores: unknown[] = []): Promise<Res> {
  return enRollback(db, ctx, async (tx): Promise<Res> => {
    try {
      return { ok: true, rows: (await tx.query(sql, valores)).rows };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { ok: false, code: String(err.code ?? ""), message: String(err.message ?? "") };
    }
  });
}

export interface DatosRol {
  id?: string | null;
  nombre: string;
  alcance: AlcanceRol;
  permisos: readonly string[];
}
const SQL_GUARDAR = "select acceso.rol_guardar($1::uuid, $2::text, $3::text, $4::text[]) as id";
export const guardar = (db: ContappDb, ctx: ContextoTenant, r: DatosRol): Promise<Res> =>
  ejecutar(db, ctx, SQL_GUARDAR, [r.id ?? null, r.nombre, r.alcance, [...r.permisos]]);
/** `guardar` en una transaccion que se revierte. */
export const probarGuardar = (db: ContappDb, ctx: ContextoTenant, r: DatosRol): Promise<Res> =>
  probar(db, ctx, SQL_GUARDAR, [r.id ?? null, r.nombre, r.alcance, [...r.permisos]]);
export const eliminar = (db: ContappDb, ctx: ContextoTenant, id: string): Promise<Res> =>
  ejecutar(db, ctx, "select acceso.rol_eliminar($1::uuid)", [id]);
export const impacto = (db: ContappDb, ctx: ContextoTenant, id: string, alcance: AlcanceRol, permisos: readonly string[]): Promise<Res> =>
  ejecutar(db, ctx, "select * from acceso.rol_impacto($1::uuid, $2::text, $3::text[])", [id, alcance, [...permisos]]);

/** Permisos guardados del rol (orden alfabetico). */
export async function permisosDe(admin: Pool, rolId: string): Promise<string[]> {
  const r = await admin.query("select permiso from rol_permiso where rol_id = $1 order by permiso", [rolId]);
  return r.rows.map((x) => x.permiso as string).sort();
}

export interface RolSembrado {
  id: string;
  nombre: string;
}

export class EscenarioRoles extends EscenarioAcceso {
  private nr = 0;
  private readonly dbs: ContappDb[] = [];

  /** Conexion de contapp_backend (la que usa el backend); se cierra con `cerrar()`. */
  backend(max = 3): ContappDb {
    const d = crearDb("contapp_backend", max);
    this.dbs.push(d);
    return d;
  }
  async cerrar(): Promise<void> {
    await Promise.all(this.dbs.map((d) => d.close().catch(() => undefined)));
  }

  /** Rol propio sembrado directamente (conexion administrativa); `permisos` se guardan tal cual, sin completar U3. */
  async rol(
    tenantId: string,
    o: { nombre?: string; alcance?: AlcanceRol; permisos?: readonly string[] } = {},
  ): Promise<RolSembrado> {
    const id = randomUUID();
    const nombre = o.nombre ?? `Rol T1 ${this.esc.marca}-${++this.nr}`;
    await this.admin.query("insert into rol (tenant_id, id, nombre, alcance) values ($1, $2, $3, $4)", [tenantId, id, nombre, o.alcance ?? "asignado"]);
    for (const p of o.permisos ?? []) {
      await this.admin.query("insert into rol_permiso (tenant_id, rol_id, permiso) values ($1, $2, $3)", [tenantId, id, p]);
    }
    return { id, nombre };
  }

  /** Miembro (activo, o desactivado) con un rol propio ya sembrado. */
  async miembroPropio(tenantId: string, rolId: string, o: { desactivada?: boolean } = {}): Promise<{ id: string; correo: string }> {
    const u = await this.cuenta();
    await this.admin.query(
      `insert into membresia (tenant_id, usuario_id, rol, rol_id, desactivada_en)
       values ($1, $2, 'propio', $3, case when $4::boolean then now() else null end)`,
      [tenantId, u.id, rolId, o.desactivada ?? false],
    );
    return { id: u.id, correo: u.correo };
  }

  /** Miembro con un rol propio nuevo con exactamente esos permisos (cerrados por U3 salvo `exacto`). */
  async actor(
    tenantId: string,
    permisos: readonly string[],
    alcance: AlcanceRol = "asignado",
    o: { exacto?: boolean } = {},
  ): Promise<{ id: string; correo: string; rolId: string }> {
    const rol = await this.rol(tenantId, { alcance, permisos: o.exacto ? permisos : cierreU3(permisos) });
    const m = await this.miembroPropio(tenantId, rol.id);
    return { ...m, rolId: rol.id };
  }

  /** Invitacion vigente con un rol propio, insertada directamente. */
  async invitacionPropia(
    tenantId: string,
    rolId: string,
    invitadoPor: string,
    o: { vencida?: boolean; revocada?: boolean; aceptada?: boolean } = {},
  ): Promise<InvitacionPrueba & { rolId: string }> {
    const base = await this.invitacion(tenantId, { invitadoPor, ...o });
    await this.admin.query("update invitacion set rol = 'propio', rol_id = $2 where id = $1", [base.id, rolId]);
    return { ...base, rolId };
  }

  async roles(tenantId: string): Promise<number> {
    return (await this.admin.query("select count(*)::int as n from rol where tenant_id = $1", [tenantId])).rows[0].n as number;
  }
}

export { sha256 };

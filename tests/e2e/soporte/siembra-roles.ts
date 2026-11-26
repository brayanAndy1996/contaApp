// Consultas y siembra de roles propios por SQL (spec 030, T5). Misma regla que `siembra.ts`: solo opera sobre la BD de la E2E con la
// conexión de migraciones (superusuario). Solo LEE `rol`, `rol_permiso`, `membresia` e `invitacion` (el rol se crea siempre por la
// pantalla o la API: la escritura directa está cerrada, 030 D1) y siembra una asignación de cliente.
//
// La limpieza de las filas de `rol`/`rol_permiso` de un estudio no vive aquí: la hace `SiembraCuenta.limpiar()`, que borra en modo
// réplica toda tabla con FK a `tenant` (descubierta por catálogo) y lanza si queda algo (plan 030 «Riesgos»: soportes).
import { Pool } from "pg";
import { BD_E2E } from "./pila/entorno.js";
import type { Cliente, TipoAsignacion } from "./siembra.js";

export interface RolPropio {
  readonly id: string;
  readonly nombre: string;
  readonly alcance: "global" | "asignado";
  /** Ordenados alfabéticamente. */
  readonly permisos: readonly string[];
}

export interface RolDeFila {
  readonly rol: string;
  readonly rolId: string | null;
}

/** `RolAsignado = Rol | { rolId }` (plan 030, Contratos: Shared): el rol propio viaja como objeto. */
export const rolAsignado = (rolId: string): { rolId: string } => ({ rolId });

export class SiembraRoles {
  private readonly pool: Pool;

  constructor(urlMigraciones: string) {
    if (new URL(urlMigraciones).pathname !== `/${BD_E2E}`) {
      throw new Error(`La siembra de roles solo opera sobre ${BD_E2E}.`);
    }
    this.pool = new Pool({ connectionString: urlMigraciones, max: 2 });
  }

  async cerrar(): Promise<void> {
    await this.pool.end();
  }

  /** El rol propio del estudio con ese nombre exacto, o `null` si no existe. */
  async rolPorNombre(
    tenantId: string,
    nombre: string,
  ): Promise<RolPropio | null> {
    const r = await this.pool.query<{
      id: string;
      nombre: string;
      alcance: "global" | "asignado";
      permisos: string[];
    }>(
      `select r.id, r.nombre, r.alcance,
              coalesce(array_agg(p.permiso order by p.permiso) filter (where p.permiso is not null), '{}') as permisos
         from rol r
         left join rol_permiso p on p.tenant_id = r.tenant_id and p.rol_id = r.id
        where r.tenant_id = $1 and r.nombre = $2
        group by r.id, r.nombre, r.alcance`,
      [tenantId, nombre],
    );
    const f = r.rows[0];
    return f === undefined
      ? null
      : {
          id: f.id,
          nombre: f.nombre,
          alcance: f.alcance,
          permisos: f.permisos,
        };
  }

  /** ¿Existe el rol propio? (para comprobar que un `DELETE` rechazado no lo borró, o que uno aceptado sí). */
  async rolExiste(rolId: string): Promise<boolean> {
    const r = await this.pool.query("select 1 from rol where id = $1", [rolId]);
    return (r.rowCount ?? 0) > 0;
  }

  /** Cuántos roles propios tiene el estudio. */
  async cuantosRoles(tenantId: string): Promise<number> {
    const r = await this.pool.query<{ n: string }>(
      "select count(*)::text as n from rol where tenant_id = $1",
      [tenantId],
    );
    return Number(r.rows[0]?.n ?? 0);
  }

  /** Cuántas asignaciones de cliente tiene el estudio (para comprobar que un 404 no escribe). */
  async cuantasAsignaciones(tenantId: string): Promise<number> {
    const r = await this.pool.query<{ n: string }>(
      "select count(*)::text as n from asignacion where tenant_id = $1",
      [tenantId],
    );
    return Number(r.rows[0]?.n ?? 0);
  }

  /** `rol` y `rol_id` de la membresía del usuario en el estudio. */
  async rolDeMembresia(
    tenantId: string,
    usuarioId: string,
  ): Promise<RolDeFila | null> {
    const r = await this.pool.query<{ rol: string; rol_id: string | null }>(
      "select rol, rol_id from membresia where tenant_id = $1 and usuario_id = $2",
      [tenantId, usuarioId],
    );
    const f = r.rows[0];
    return f === undefined ? null : { rol: f.rol, rolId: f.rol_id };
  }

  /** `rol` y `rol_id` de la invitación (la más reciente) a ese correo en el estudio. */
  async rolDeInvitacion(
    tenantId: string,
    correo: string,
  ): Promise<RolDeFila | null> {
    const r = await this.pool.query<{ rol: string; rol_id: string | null }>(
      `select rol, rol_id from invitacion
        where tenant_id = $1 and correo = $2 order by creada_en desc limit 1`,
      [tenantId, correo.toLowerCase()],
    );
    const f = r.rows[0];
    return f === undefined ? null : { rol: f.rol, rolId: f.rol_id };
  }

  /**
   * CA-6: membresías e invitaciones con rol `'propio'` cuyo rol no existe o es de otro estudio. Debe ser 0 siempre (las FK
   * compuestas `(tenant_id, rol_id)` lo garantizan; aquí se comprueba el resultado visible, no el mecanismo).
   */
  async huerfanos(tenantId: string): Promise<number> {
    const r = await this.pool.query<{ n: string }>(
      `select (
         (select count(*) from membresia m
           where m.tenant_id = $1 and (m.rol = 'propio') <> (m.rol_id is not null))
       + (select count(*) from membresia m
           where m.tenant_id = $1 and m.rol_id is not null
             and not exists (select 1 from rol r where r.tenant_id = m.tenant_id and r.id = m.rol_id))
       + (select count(*) from invitacion i
           where i.tenant_id = $1 and (i.rol = 'propio') <> (i.rol_id is not null))
       + (select count(*) from invitacion i
           where i.tenant_id = $1 and i.rol_id is not null
             and not exists (select 1 from rol r where r.tenant_id = i.tenant_id and r.id = i.rol_id))
       )::text as n`,
      [tenantId],
    );
    return Number(r.rows[0]?.n ?? 0);
  }

  /** El id del usuario con ese correo (la persona invitada crea su cuenta por la pantalla, así que la prueba lo busca después). */
  async usuarioIdPorCorreo(correo: string): Promise<string> {
    const r = await this.pool.query<{ id: string }>(
      "select id from usuario where email = $1",
      [correo.toLowerCase()],
    );
    const id = r.rows[0]?.id;
    if (id === undefined) throw new Error("No existe el usuario invitado.");
    return id;
  }

  /** Asigna un cliente a un usuario del estudio (la asignación no es lo que prueba este flujo). */
  async asignar(
    cliente: Cliente,
    usuarioId: string,
    tipo: TipoAsignacion = "colaborador",
  ): Promise<void> {
    await this.pool.query(
      `insert into asignacion (tenant_id, cliente_id, usuario_id, tipo) values ($1, $2, $3, $4)`,
      [cliente.tenantId, cliente.id, usuarioId, tipo],
    );
  }
}

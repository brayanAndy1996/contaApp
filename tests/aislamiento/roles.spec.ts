// CA-2 (roles). Conexion: DATABASE_URL (rol de login de la app).
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirPool, filasRaw, intentarRaw, ROLES_APP, TABLAS_NEGOCIO, semilla } from "./soporte";

let pool: Pool;
beforeAll(() => {
  pool = abrirPool();
});
afterAll(async () => {
  await pool.end();
});

async function rol(nombre: string) {
  const r = await pool.query(
    `select rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin, oid
       from pg_roles where rolname = $1`,
    [nombre],
  );
  return r.rows[0] as
    | {
        rolname: string;
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolcreaterole: boolean;
        rolcreatedb: boolean;
        rolcanlogin: boolean;
        oid: number;
      }
    | undefined;
}

async function objetosDeDueño(nombre: string) {
  const r = await pool.query(
    `with r as (select oid from pg_roles where rolname = $1)
     select (select count(*) from pg_class c, r where c.relowner = r.oid)::int as clases,
            (select count(*) from pg_proc p, r where p.proowner = r.oid)::int as funciones,
            (select count(*) from pg_namespace n, r where n.nspowner = r.oid)::int as esquemas,
            (select count(*) from pg_type t, r where t.typowner = r.oid)::int as tipos,
            (select count(*) from pg_database d, r where d.datdba = r.oid)::int as bases
     from r`,
    [nombre],
  );
  return r.rows[0] as Record<string, number> | undefined;
}

describe("CA-2 roles de la app", () => {
  it("existen los cinco roles del plan", async () => {
    for (const n of ["contapp_migrator", "contapp_backend", "contapp_worker", "contapp_platform", "contapp_app"]) {
      expect(await rol(n), n).toBeDefined();
    }
  });

  it.each(ROLES_APP)("%s: sin SUPERUSER ni BYPASSRLS, sin login y sin objetos propios", async (nombre) => {
    const r = await rol(nombre);
    expect(r).toBeDefined();
    expect(r!.rolsuper).toBe(false);
    expect(r!.rolbypassrls).toBe(false);
    expect(r!.rolcreaterole).toBe(false);
    expect(r!.rolcreatedb).toBe(false);
    expect(r!.rolcanlogin).toBe(false);
    const o = await objetosDeDueño(nombre);
    expect(o, "rol inexistente").toBeDefined();
    expect(o).toEqual({ clases: 0, funciones: 0, esquemas: 0, tipos: 0, bases: 0 });
  });

  it("contapp_platform tiene BYPASSRLS y no es superusuario", async () => {
    const r = await rol("contapp_platform");
    expect(r).toBeDefined();
    expect(r!.rolbypassrls).toBe(true);
    expect(r!.rolsuper).toBe(false);
    expect(r!.rolcanlogin).toBe(false);
  });

  // D8 (spec 002): contapp_platform queda fuera del alcance del login; no se puede ejercer via SET ROLE,
  // asi que el "permission denied" sobre negocio se verifica con los privilegios efectivos del catalogo.
  it.each(TABLAS_NEGOCIO)("contapp_platform no tiene ningun privilegio (permission denied) sobre %s", async (tabla) => {
    const r = await pool.query(
      `select has_table_privilege('contapp_platform', $1, 'SELECT')     as sel,
              has_table_privilege('contapp_platform', $1, 'INSERT')     as ins,
              has_table_privilege('contapp_platform', $1, 'UPDATE')     as upd,
              has_table_privilege('contapp_platform', $1, 'DELETE')     as del,
              has_table_privilege('contapp_platform', $1, 'TRUNCATE')   as trunc,
              has_table_privilege('contapp_platform', $1, 'REFERENCES') as ref,
              has_table_privilege('contapp_platform', $1, 'TRIGGER')    as trg,
              has_any_column_privilege('contapp_platform', $1, 'SELECT')     as csel,
              has_any_column_privilege('contapp_platform', $1, 'INSERT')     as cins,
              has_any_column_privilege('contapp_platform', $1, 'UPDATE')     as cupd,
              has_any_column_privilege('contapp_platform', $1, 'REFERENCES') as cref`,
      [tabla],
    );
    expect(r.rows[0], tabla).toEqual({
      sel: false, ins: false, upd: false, del: false, trunc: false, ref: false, trg: false,
      csel: false, cins: false, cupd: false, cref: false,
    });
  });

  it("contapp_platform si tiene privilegios sobre tablas de plataforma (el rechazo es por grants, no un fallo general)", async () => {
    const r = await pool.query(
      `select has_table_privilege('contapp_platform', 'tenant', 'SELECT') as sel,
              has_schema_privilege('contapp_platform', 'public', 'USAGE')  as uso`,
    );
    expect(r.rows[0]).toEqual({ sel: true, uso: true });
  });

  it("el login de la app NO puede asumir contapp_platform (SET ROLE rechazado con permission denied)", async () => {
    const r = await intentarRaw(pool, null, "SET ROLE contapp_platform");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("42501");
      expect(r.message).toMatch(/permission denied/i);
    }
  });

  it("tras el rechazo de SET ROLE contapp_platform la sesion sigue siendo contapp_app, sin acceso a negocio", async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await expect(c.query("SET LOCAL ROLE contapp_platform")).rejects.toMatchObject({ code: "42501" });
      await c.query("ROLLBACK");
      await c.query("BEGIN");
      expect((await c.query("select current_user as u")).rows[0].u).toBe("contapp_app");
      await expect(c.query("select 1 from cliente limit 1")).rejects.toMatchObject({ code: "42501" });
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  });
});

describe("CA-2 rol de login de DATABASE_URL", () => {
  it("es contapp_app, sin SUPERUSER, BYPASSRLS, CREATEROLE ni CREATEDB", async () => {
    const actual = (await pool.query("select current_user as u")).rows[0].u as string;
    expect(actual).toBe("contapp_app");
    const r = await rol(actual);
    expect(r).toBeDefined();
    expect(r!.rolsuper).toBe(false);
    expect(r!.rolbypassrls).toBe(false);
    expect(r!.rolcreaterole).toBe(false);
    expect(r!.rolcreatedb).toBe(false);
    expect(r!.rolcanlogin).toBe(true);
  });

  it("no es dueño de ningun objeto", async () => {
    const o = await objetosDeDueño("contapp_app");
    expect(o, "rol inexistente").toBeDefined();
    expect(o).toEqual({ clases: 0, funciones: 0, esquemas: 0, tipos: 0, bases: 0 });
  });

  it("sus membresias son solo backend y worker (nunca platform), con INHERIT FALSE y SET TRUE", async () => {
    const r = await pool.query(
      `select g.rolname as rol, m.inherit_option, m.set_option, m.admin_option
         from pg_auth_members m
         join pg_roles g on g.oid = m.roleid
         join pg_roles u on u.oid = m.member
        where u.rolname = 'contapp_app'
        order by g.rolname`,
    );
    expect(r.rows.map((x) => x.rol)).toEqual(["contapp_backend", "contapp_worker"]);
    for (const x of r.rows) {
      expect(x.inherit_option, x.rol).toBe(false);
      expect(x.set_option, x.rol).toBe(true);
      expect(x.admin_option, x.rol).toBe(false);
    }
  });

  it("sin SET ROLE no tiene privilegios sobre tablas (INHERIT FALSE en consultas reales)", async () => {
    for (const t of [...TABLAS_NEGOCIO, "tenant", "usuario"]) {
      const r = await intentarRaw(pool, null, `select 1 from ${t} limit 1`);
      expect(r.ok, t).toBe(false);
      if (!r.ok) expect(r.code, t).toBe("42501");
    }
  });

  it("RESET ROLE tras SET ROLE contapp_backend solo vuelve al rol de login, sin acceso a negocio", async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE contapp_backend");
      await c.query("RESET ROLE");
      expect((await c.query("select current_user as u")).rows[0].u).toBe("contapp_app");
      await expect(c.query("select 1 from cliente limit 1")).rejects.toMatchObject({ code: "42501" });
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  });

  it("no puede asumir contapp_migrator ni un superusuario (SET ROLE / SET SESSION AUTHORIZATION)", async () => {
    const supers = (await pool.query("select rolname from pg_roles where rolsuper")).rows.map(
      (x) => x.rolname as string,
    );
    expect(supers.length).toBeGreaterThan(0);
    const objetivos = ["contapp_migrator", ...supers];
    for (const o of objetivos) {
      const nombre = `"${o.replace(/"/g, '""')}"`;
      for (const sql of [`SET ROLE ${nombre}`, `SET SESSION AUTHORIZATION ${nombre}`]) {
        const r = await intentarRaw(pool, null, sql);
        expect(r.ok, `${sql}`).toBe(false);
        if (!r.ok) expect(r.code, sql).toBe("42501");
      }
    }
  });
});

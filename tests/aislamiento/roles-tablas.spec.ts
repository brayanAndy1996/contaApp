// Spec 030 (T1, rojo hasta 0082) · CA-1, CA-2, CA-6, CA-9, D1, D2, U7, U9: tablas `rol` y `rol_permiso`, sus CHECK y llaves, la RLS FORCE,
// la escritura directa cerrada y las columnas `rol_id` de membresia e invitacion. Cada prueba crea sus estudios (EscenarioRoles) y los borra.
// Rojo por: las tablas rol / rol_permiso y la columna rol_id no existen (42P01 / 42703) hasta la migracion 0082.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PERMISOS_ASIGNABLES, COD, EscenarioRoles, ejecutar } from "./roles-soporte";
import { abrirAdmin, abrirApp } from "./auth-soporte";
import { intentarRaw } from "./soporte";

vi.setConfig({ testTimeout: 60_000 });

let admin: Pool;
let app: Pool;
let er: EscenarioRoles;
beforeAll(() => {
  admin = abrirAdmin(6);
  app = abrirApp(4);
  er = new EscenarioRoles(admin);
});
afterAll(async () => {
  await er?.limpiar();
  await er?.cerrar();
  await app?.end();
  await admin?.end();
});

const adm = async (sql: string, v: unknown[] = []) => (await admin.query(sql, v)).rows;
/** Sentencia de escritura con la conexion administrativa dentro de una transaccion que siempre se revierte; devuelve el SQLSTATE o "ok". */
async function admRollback(sql: string, v: unknown[] = []): Promise<string> {
  const c = await admin.connect();
  try {
    await c.query("BEGIN");
    await c.query(sql, v);
    return "ok";
  } catch (e) {
    return String((e as { code?: string }).code);
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    c.release();
  }
}

describe("estructura de rol y rol_permiso (D1)", () => {
  it("rol tiene las columnas del plan; nombre_clave es GENERATED ALWAYS y los demas campos son NOT NULL", async () => {
    const cols = await adm(
      `select column_name, is_nullable, is_generated from information_schema.columns
        where table_schema = 'public' and table_name = 'rol' order by column_name`,
    );
    expect(cols.map((c) => c.column_name).sort()).toEqual(["actualizado_en", "alcance", "creado_en", "id", "nombre", "nombre_clave", "tenant_id"].sort());
    for (const c of cols) expect(c.is_nullable, c.column_name).toBe("NO");
    expect(cols.find((c) => c.column_name === "nombre_clave")?.is_generated).toBe("ALWAYS");
  });

  it("rol_permiso tiene (tenant_id, rol_id, permiso) con PK (rol_id, permiso)", async () => {
    const cols = await adm(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'rol_permiso' order by column_name",
    );
    expect(cols.map((c) => c.column_name)).toEqual(["permiso", "rol_id", "tenant_id"]);
    const pk = await adm(
      `select a.attname from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
        where i.indrelid = 'public.rol_permiso'::regclass and i.indisprimary order by a.attname`,
    );
    expect(pk.map((r) => r.attname)).toEqual(["permiso", "rol_id"]);
  });

  it("membresia e invitacion tienen rol_id (uuid, NULL) y sus CHECK de rol admiten 'propio'", async () => {
    for (const t of ["membresia", "invitacion"]) {
      const c = await adm(
        "select data_type, is_nullable from information_schema.columns where table_schema = 'public' and table_name = $1 and column_name = 'rol_id'",
        [t],
      );
      expect(c, t).toEqual([{ data_type: "uuid", is_nullable: "YES" }]);
      const checks = (await adm("select pg_get_constraintdef(oid) as d from pg_constraint where conrelid = $1::regclass and contype = 'c'", [`public.${t}`])).map(
        (r) => r.d as string,
      );
      expect(checks.some((d) => d.includes("'propio'") && d.includes("'dueno'")), `${t}: CHECK de rol con propio`).toBe(true);
    }
  });
});

describe("RLS FORCE y privilegios (CA-9)", () => {
  it.each(["rol", "rol_permiso"])("%s: RLS ENABLE + FORCE, una politica tenant_isolation por app.tenant_id y dueño contapp_migrator", async (t) => {
    const [c] = await adm(
      `select c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) as dueno from pg_class c where c.oid = $1::regclass`,
      [`public.${t}`],
    );
    expect(c).toEqual({ relrowsecurity: true, relforcerowsecurity: true, dueno: "contapp_migrator" });
    const pol = await adm("select polname, pg_get_expr(polqual, polrelid) as q from pg_policy where polrelid = $1::regclass", [`public.${t}`]);
    expect(pol.map((p) => p.polname)).toEqual(["tenant_isolation"]);
    expect(pol[0].q).toContain("app.tenant_id");
  });

  it.each(["rol", "rol_permiso"])("%s: contapp_backend solo tiene SELECT; worker, platform, app y PUBLIC no tienen ningun privilegio", async (t) => {
    const privs = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
    const tiene = async (rol: string) => {
      const r = await adm(`select p, has_table_privilege($1, $2::regclass, p) as ok from unnest($3::text[]) p`, [rol, `public.${t}`, privs]);
      return r.filter((x) => x.ok).map((x) => x.p as string);
    };
    expect(await tiene("contapp_backend")).toEqual(["SELECT"]);
    for (const rol of ["contapp_worker", "contapp_platform", "contapp_app"]) expect(await tiene(rol), rol).toEqual([]);
    const publico = await adm("select count(*)::int as n from information_schema.table_privileges where table_schema = 'public' and table_name = $1 and grantee = 'PUBLIC'", [t]);
    expect(publico[0].n).toBe(0);
  });

  it("escritura directa cerrada: contapp_backend no puede INSERT/UPDATE/DELETE en rol ni en rol_permiso (solo las funciones escriben)", async () => {
    const x = await er.estudio();
    const r = await er.rol(x.id, { permisos: ["clientes.ver"] });
    const intentos: Record<string, string> = {};
    const sentencias: Record<string, [string, unknown[]]> = {
      "insert rol": ["insert into rol (tenant_id, nombre, alcance) values ($1, 'Directo', 'asignado')", [x.id]],
      "update rol": ["update rol set nombre = 'Cambiado' where id = $1", [r.id]],
      "delete rol": ["delete from rol where id = $1", [r.id]],
      "insert rol_permiso": ["insert into rol_permiso (tenant_id, rol_id, permiso) values ($1, $2, 'clientes.crear')", [x.id, r.id]],
      "delete rol_permiso": ["delete from rol_permiso where rol_id = $1", [r.id]],
    };
    for (const [n, [sql, v]] of Object.entries(sentencias)) {
      const i = await intentarRaw(app, "contapp_backend", sql, v);
      intentos[n] = i.ok ? "ok" : i.code;
    }
    expect(intentos).toEqual(Object.fromEntries(Object.keys(sentencias).map((n) => [n, "42501"])));
    expect(await adm("select count(*)::int as n from rol_permiso where rol_id = $1", [r.id])).toEqual([{ n: 1 }]);
  });

  it("aislamiento (CA-9): contapp_backend ve solo los roles de su estudio; sin estudio fijado, ninguno", async () => {
    const a = await er.estudio();
    const b = await er.estudio();
    const ra = await er.rol(a.id, { permisos: ["clientes.ver"] });
    const rb = await er.rol(b.id, { permisos: ["clientes.ver"] });
    const db = er.backend();
    const deA = await ejecutar(db, { tenantId: a.id }, "select id from rol");
    const permisosDeA = await ejecutar(db, { tenantId: a.id }, "select rol_id from rol_permiso");
    expect(deA.ok && deA.rows.map((r) => r.id)).toEqual([ra.id]);
    expect(permisosDeA.ok && permisosDeA.rows.map((r) => r.rol_id)).toEqual([ra.id]);
    const ajeno = await ejecutar(db, { tenantId: a.id }, "select id from rol where id = $1", [rb.id]);
    expect(ajeno.ok && ajeno.rows).toEqual([]);
    const sinEstudio = await intentarRaw(app, "contapp_backend", "select id from rol");
    expect(sinEstudio.ok && sinEstudio.rowCount).toBe(0);
  });
});

describe("CHECK y UNIQUE de rol (CA-1, CA-2, D1)", () => {
  it("nombre_clave es el nombre en minusculas y sin tildes; UNIQUE (tenant_id, nombre_clave) distingue estudios", async () => {
    const a = await er.estudio();
    const b = await er.estudio();
    const r = await er.rol(a.id, { nombre: "Contabilidád Gestión" });
    expect((await adm("select nombre_clave from rol where id = $1", [r.id]))[0].nombre_clave).toBe("contabilidad gestion");
    const mismo = (n: string, t: string) => admRollback("insert into rol (tenant_id, nombre, alcance) values ($1, $2, 'asignado')", [t, n]).then((c) => c);
    expect(await mismo("CONTABILIDAD GESTION", a.id)).toBe(COD.duplicado);
    expect(await mismo("contabilidad gestion", a.id)).toBe(COD.duplicado);
    expect(await mismo("contabilidad gestion", b.id), "otro estudio: permitido").toBe("ok");
  });

  it.each(["Dueño", "DUEÑO", "dueno", "Administrador", "ADMINISTRADOR", "Contador", "asistente", "Lectura"])(
    "el nombre %s coincide con un rol de sistema: CHECK 23514",
    async (nombre) => {
      const x = await er.estudio();
      expect(await admRollback("insert into rol (tenant_id, nombre, alcance) values ($1, $2, 'asignado')", [x.id, nombre])).toBe(COD.check);
    },
  );

  it.each([
    ["vacio", ""],
    ["41 caracteres", "x".repeat(41)],
    ["salto de linea", "Ana\nBeto"],
    ["tabulacion", "Ana\tBeto"],
    ["caracter de control U+0001", "Ana\u0001Beto"],
  ])("nombre mal formado (%s): CHECK 23514 (defensa en profundidad del zod 1..40 sin controles)", async (_n, nombre) => {
    const x = await er.estudio();
    expect(await admRollback("insert into rol (tenant_id, nombre, alcance) values ($1, $2, 'asignado')", [x.id, nombre])).toBe(COD.check);
  });

  it("40 caracteres es valido", async () => {
    const x = await er.estudio();
    expect(await admRollback("insert into rol (tenant_id, nombre, alcance) values ($1, $2, 'asignado')", [x.id, "x".repeat(40)])).toBe("ok");
  });

  it.each(["global", "asignado"])("alcance %s valido", async (alcance) => {
    const x = await er.estudio();
    expect(await admRollback("insert into rol (tenant_id, nombre, alcance) values ($1, 'Con alcance', $2)", [x.id, alcance])).toBe("ok");
  });

  it.each(["todos", "", "GLOBAL", "propio"])("alcance %j fuera de global/asignado: CHECK 23514", async (alcance) => {
    const x = await er.estudio();
    expect(await admRollback("insert into rol (tenant_id, nombre, alcance) values ($1, 'Mal alcance', $2)", [x.id, alcance])).toBe(COD.check);
  });

  it("rol de un tenant que no existe: FK 23503", async () => {
    expect(await admRollback("insert into rol (tenant_id, nombre, alcance) values ('00000000-0000-4000-8000-000000000001', 'Huerfano', 'asignado')")).toBe(COD.enUso);
  });
});

describe("CHECK del catalogo y FK compuestas de rol_permiso (CA-2, CA-9)", () => {
  it("los 23 permisos asignables se aceptan", async () => {
    const x = await er.estudio();
    const r = await er.rol(x.id);
    for (const p of PERMISOS_ASIGNABLES) {
      expect(await admRollback("insert into rol_permiso (tenant_id, rol_id, permiso) values ($1, $2, $3)", [x.id, r.id, p]), p).toBe("ok");
    }
  });

  it.each(["plan.gestionar", "", "root", "clientes", "Clientes.ver", "sire.borrar_todo", "clientes.ver "])(
    "el permiso %j (fuera del catalogo o plan.gestionar) se rechaza con CHECK 23514, tambien al superusuario",
    async (permiso) => {
      const x = await er.estudio();
      const r = await er.rol(x.id);
      expect(await admRollback("insert into rol_permiso (tenant_id, rol_id, permiso) values ($1, $2, $3)", [x.id, r.id, permiso])).toBe(COD.check);
    },
  );

  it("un permiso no se repite en el mismo rol (PK)", async () => {
    const x = await er.estudio();
    const r = await er.rol(x.id, { permisos: ["clientes.ver"] });
    expect(await admRollback("insert into rol_permiso (tenant_id, rol_id, permiso) values ($1, $2, 'clientes.ver')", [x.id, r.id])).toBe(COD.duplicado);
  });

  it("FK compuesta (tenant_id, rol_id): no se cuelga un permiso de un rol de otro estudio (23503)", async () => {
    const a = await er.estudio();
    const b = await er.estudio();
    const rb = await er.rol(b.id);
    expect(await admRollback("insert into rol_permiso (tenant_id, rol_id, permiso) values ($1, $2, 'clientes.ver')", [a.id, rb.id])).toBe(COD.enUso);
  });

  it("borrar un rol borra sus permisos (ON DELETE CASCADE)", async () => {
    const x = await er.estudio();
    const r = await er.rol(x.id, { permisos: ["clientes.ver", "buzon.ver"] });
    const c = await admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("delete from rol where id = $1", [r.id]);
      expect((await c.query("select count(*)::int as n from rol_permiso where rol_id = $1", [r.id])).rows[0].n).toBe(0);
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  });

  it("las FK de rol y membresia/invitacion son compuestas con tenant_id y ON DELETE como en el plan (RESTRICT para las asignaciones)", async () => {
    const defs = async (tabla: string) =>
      (await adm("select pg_get_constraintdef(oid) as d from pg_constraint where conrelid = $1::regclass and contype = 'f'", [`public.${tabla}`])).map((r) => r.d as string);
    expect((await defs("rol_permiso")).find((d) => d.includes("REFERENCES rol"))).toMatch(/FOREIGN KEY \(tenant_id, rol_id\) REFERENCES rol\(tenant_id, id\) ON DELETE CASCADE/);
    for (const t of ["membresia", "invitacion"]) {
      expect((await defs(t)).find((d) => d.includes("REFERENCES rol"))).toMatch(/FOREIGN KEY \(tenant_id, rol_id\) REFERENCES rol\(tenant_id, id\) ON DELETE RESTRICT/);
    }
  });
});

describe("rol_id de membresia e invitacion: CHECK ((rol = 'propio') = (rol_id IS NOT NULL)) y FK RESTRICT (CA-6, D2)", () => {
  it("membresia: 'propio' sin rol_id, o rol_id con un rol de sistema, se rechazan (23514)", async () => {
    const x = await er.estudio();
    const r = await er.rol(x.id);
    const u1 = await er.cuenta();
    const u2 = await er.cuenta();
    expect(await admRollback("insert into membresia (tenant_id, usuario_id, rol) values ($1, $2, 'propio')", [x.id, u1.id])).toBe(COD.check);
    expect(await admRollback("insert into membresia (tenant_id, usuario_id, rol, rol_id) values ($1, $2, 'contador', $3)", [x.id, u2.id, r.id])).toBe(COD.check);
    expect(await admRollback("insert into membresia (tenant_id, usuario_id, rol, rol_id) values ($1, $2, 'propio', $3)", [x.id, u1.id, r.id])).toBe("ok");
  });

  it("invitacion: la misma regla", async () => {
    const x = await er.estudio();
    const d = await er.miembro(x.id, "dueno");
    const r = await er.rol(x.id);
    const i = await er.invitacion(x.id, { invitadoPor: d.id });
    expect(await admRollback("update invitacion set rol = 'propio' where id = $1", [i.id])).toBe(COD.check);
    expect(await admRollback("update invitacion set rol_id = $2 where id = $1", [i.id, r.id])).toBe(COD.check);
    expect(await admRollback("update invitacion set rol = 'propio', rol_id = $2 where id = $1", [i.id, r.id])).toBe("ok");
  });

  it("FK compuesta: un rol de OTRO estudio no se asigna (membresia e invitacion, 23503)", async () => {
    const a = await er.estudio();
    const b = await er.estudio();
    const d = await er.miembro(a.id, "dueno");
    const rb = await er.rol(b.id);
    const u = await er.cuenta();
    expect(await admRollback("insert into membresia (tenant_id, usuario_id, rol, rol_id) values ($1, $2, 'propio', $3)", [a.id, u.id, rb.id])).toBe(COD.enUso);
    const i = await er.invitacion(a.id, { invitadoPor: d.id });
    expect(await admRollback("update invitacion set rol = 'propio', rol_id = $2 where id = $1", [i.id, rb.id])).toBe(COD.enUso);
  });

  it("ON DELETE RESTRICT: no se borra un rol asignado a una membresia o a una invitacion (23503), tampoco con el superusuario", async () => {
    const x = await er.estudio();
    const d = await er.miembro(x.id, "dueno");
    const conMiembro = await er.rol(x.id);
    await er.miembroPropio(x.id, conMiembro.id);
    const conInvitacion = await er.rol(x.id);
    await er.invitacionPropia(x.id, conInvitacion.id, d.id);
    expect(await admRollback("delete from rol where id = $1", [conMiembro.id])).toBe(COD.enUso);
    expect(await admRollback("delete from rol where id = $1", [conInvitacion.id])).toBe(COD.enUso);
    const libre = await er.rol(x.id);
    expect(await admRollback("delete from rol where id = $1", [libre.id])).toBe("ok");
  });

  it("U7: un rol propio no cuenta como Dueño; el unico Dueño no puede pasar a propio (P0001) y el estudio conserva su Dueño", async () => {
    const x = await er.estudio();
    const d = await er.miembro(x.id, "dueno");
    const r = await er.rol(x.id, { alcance: "global", permisos: [...PERMISOS_ASIGNABLES] });
    expect(await admRollback("update membresia set rol = 'propio', rol_id = $2 where usuario_id = $1", [d.id, r.id])).toBe("P0001");
    const otro = await er.miembro(x.id, "dueno");
    expect(await admRollback("update membresia set rol = 'propio', rol_id = $2 where usuario_id = $1", [otro.id, r.id]), "con dos Dueños se puede").toBe("ok");
  });
});

// Spec 008 (T3, rojo): catalogo y privilegios de la BD de trabajos (CA-9, CA-12, CA-13, CA-15; D13, D16, D18, D19).
// Solo lee el catalogo de PostgreSQL con el rol administrativo (MIGRATIONS_DATABASE_URL); no escribe nada.
// El comportamiento (RLS, FK, CHECK, trigger, funciones) esta en trabajos-funciones.spec.ts.
//
// Contrato que fija (T7, migraciones 0017 y 0018; plan "BD"):
// - job_registro: 21 columnas (COLUMNAS_JOB), dueño contapp_migrator, RLS ENABLE+FORCE, tenant_isolation FOR ALL y UNA
//   politica FOR DELETE para contapp_worker; FK compuestas (tenant_id, cliente_id) -> cliente(tenant_id, id) y
//   (tenant_id, creado_por) -> membresia(tenant_id, usuario_id); indice unico parcial de dedupe sobre estados vivos.
// - grants: contapp_backend SELECT + INSERT + UPDATE(estado, motivo, terminado_en, actualizado_en);
//   contapp_worker SELECT + DELETE + UPDATE(estado, intentos, motivo, resultado, disponible_desde, iniciado_en,
//   terminado_en, actualizado_en); contapp_platform y contapp_app: nada; PUBLIC: nada.
// - config_sistema: sin tenant_id, dueño contapp_migrator, SELECT para backend y worker, nada para los demas.
// - credencial.estado / estado_motivo / estado_at; trigger credencial_reinicia_estado.
// - rol contapp_enumerador NOLOGIN BYPASSRLS NOINHERIT, sin miembros, solo SELECT (id) ON tenant y
//   SELECT (tenant_id, estado, actualizado_en) ON job_registro.
// - esquema `sistema` (dueño contapp_migrator, USAGE solo contapp_worker) con sistema.estudios_ids() y
//   sistema.estudios_con_trabajos(text[], integer): SECURITY DEFINER, dueño contapp_enumerador, STABLE,
//   search_path = pg_catalog, pg_temp, EXECUTE solo contapp_worker, devuelven SETOF uuid.
// - auth.purgar(interval, interval, interval, interval) -> TABLE(sesiones int, tokens int, intentos int, limites int):
//   SECURITY DEFINER, dueño contapp_auth, search_path fijo, EXECUTE solo contapp_worker.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirAdmin } from "./auth-soporte";
import { abrirPool, intentarRaw } from "./soporte";
import { COLUMNAS_JOB } from "./trabajos-soporte";

let admin: Pool; // superusuario: catalogo
let pool: Pool; // contapp_app (DATABASE_URL)
beforeAll(() => {
  admin = abrirAdmin(3);
  pool = abrirPool(2);
});
afterAll(async () => {
  await pool?.end();
  await admin?.end();
});

const consulta = async (text: string, values: unknown[] = []) =>
  (await admin.query(text, values)).rows;
const PRIVS_TABLA = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
] as const;

/** Columnas de `tabla` (schema.tabla) con el privilegio `priv` para `rol`, ordenadas (tabla o columna). */
async function existe(tabla: string) {
  expect(
    (await consulta("select to_regclass($1) is not null as v", [tabla]))[0].v,
    `${tabla} existe`,
  ).toBe(true);
}
async function columnasConPrivilegio(
  tabla: string,
  rol: string,
  priv: "SELECT" | "INSERT" | "UPDATE" | "REFERENCES",
) {
  await existe(tabla);
  const r = await consulta(
    `select a.attname from pg_attribute a
      where a.attrelid = to_regclass($1) and a.attnum > 0 and not a.attisdropped
        and has_column_privilege($2, a.attrelid, a.attname, $3) order by a.attname`,
    [tabla, rol, priv],
  );
  return r.map((x) => x.attname as string).sort();
}
const tienePrivTabla = async (tabla: string, rol: string, priv: string) =>
  (
    await consulta("select has_table_privilege($1, to_regclass($2), $3) as v", [
      rol,
      tabla,
      priv,
    ])
  )[0].v as boolean;
const tieneAlguna = async (tabla: string, rol: string, priv: string) =>
  (
    await consulta(
      "select has_any_column_privilege($1, to_regclass($2), $3) as v",
      [rol, tabla, priv],
    )
  )[0].v as boolean;

/** Privilegios de tabla efectivos (tabla o columna) de `rol` sobre `tabla`, en el orden de PRIVS_TABLA. */
async function concedidos(tabla: string, rol: string): Promise<string[]> {
  await existe(tabla);
  const out: string[] = [];
  for (const p of PRIVS_TABLA) {
    const col = ["SELECT", "INSERT", "UPDATE", "REFERENCES"].includes(p)
      ? await tieneAlguna(tabla, rol, p)
      : false;
    if ((await tienePrivTabla(tabla, rol, p)) || col) out.push(p);
  }
  return out;
}

// =================================================================================================
describe("job_registro: tabla, dueño, RLS y politicas (CA-15)", () => {
  it("existe con exactamente las 21 columnas del plan", async () => {
    const r = await consulta(
      `select a.attname from pg_attribute a where a.attrelid = to_regclass('public.job_registro') and a.attnum > 0 and not a.attisdropped order by 1`,
    );
    expect(r.map((x) => x.attname)).toEqual(COLUMNAS_JOB);
  });

  it("dueño contapp_migrator, RLS ENABLE + FORCE", async () => {
    const r = await consulta(
      `select o.rolname as dueno, c.relrowsecurity as rls, c.relforcerowsecurity as forzada
         from pg_class c join pg_roles o on o.oid = c.relowner where c.oid = to_regclass('public.job_registro')`,
    );
    expect(r).toEqual([
      { dueno: "contapp_migrator", rls: true, forzada: true },
    ]);
  });

  it("tenant_id uuid NOT NULL y politica tenant_isolation FOR ALL con USING y WITH CHECK sobre app.tenant_id", async () => {
    const col = await consulta(
      `select a.attnotnull as no_nula, ty.typname as tipo from pg_attribute a join pg_type ty on ty.oid = a.atttypid
        where a.attrelid = to_regclass('public.job_registro') and a.attname = 'tenant_id' and not a.attisdropped`,
    );
    expect(col).toEqual([{ no_nula: true, tipo: "uuid" }]);
    const p = await consulta(
      `select cmd, qual, with_check from pg_policies where schemaname = 'public' and tablename = 'job_registro' and policyname = 'tenant_isolation'`,
    );
    expect(p).toHaveLength(1);
    expect(p[0].cmd).toBe("ALL");
    expect(p[0].qual).toContain("app.tenant_id");
    expect(p[0].with_check).toContain("app.tenant_id");
  });

  it("solo tiene tenant_isolation y UNA politica FOR DELETE, y esta es solo para contapp_worker", async () => {
    const r = await consulta(
      `select policyname, cmd, roles::text[] as roles, qual from pg_policies where schemaname = 'public' and tablename = 'job_registro' order by policyname`,
    );
    const otras = r.filter((p) => p.policyname !== "tenant_isolation");
    expect(otras).toHaveLength(1);
    expect(otras[0].cmd).toBe("DELETE");
    expect(otras[0].roles).toEqual(["contapp_worker"]);
    // La politica de DELETE solo alcanza los estados terminales (el comportamiento exacto lo prueba trabajos-funciones.spec.ts).
    for (const e of ["completado", "error", "cancelado"])
      expect(String(otras[0].qual)).toContain(e);
    for (const e of ["en_cola", "ejecutando"])
      expect(String(otras[0].qual)).not.toContain(e);
  });

  it("tipos y nulabilidad de las columnas clave (D1, D8, plan BD)", async () => {
    const r = await consulta(
      `select column_name, udt_name, is_nullable, column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'job_registro' order by column_name`,
    );
    const por = Object.fromEntries(r.map((x) => [x.column_name, x]));
    const esperado: Record<string, [string, string]> = {
      id: ["uuid", "NO"],
      cliente_id: ["uuid", "NO"],
      ruc: ["bpchar", "NO"],
      tipo: ["text", "NO"],
      cola: ["text", "NO"],
      canal: ["text", "NO"],
      prioridad: ["text", "NO"],
      estado: ["text", "NO"],
      parametros: ["jsonb", "NO"],
      clave_dedupe: ["bytea", "NO"],
      creado_por: ["uuid", "YES"],
      intentos: ["int2", "NO"],
      max_intentos: ["int2", "NO"],
      motivo: ["text", "YES"],
      resultado: ["jsonb", "YES"],
      disponible_desde: ["timestamptz", "NO"],
      creado_en: ["timestamptz", "NO"],
      iniciado_en: ["timestamptz", "YES"],
      terminado_en: ["timestamptz", "YES"],
      actualizado_en: ["timestamptz", "NO"],
    };
    for (const [c, [tipo, nulo]] of Object.entries(esperado)) {
      expect([por[c]?.udt_name, por[c]?.is_nullable], c).toEqual([tipo, nulo]);
    }
    expect(String(por.id?.column_default)).toContain("uuid_v7()");
    expect(String(por.intentos?.column_default)).toBe("0");
    // El INSERT del repositorio no manda estos: deben tener valor por defecto (tenant_id lo pone el contexto).
    for (const c of [
      "tenant_id",
      "creado_en",
      "actualizado_en",
      "disponible_desde",
    ]) {
      expect(por[c]?.column_default, `${c} DEFAULT`).not.toBeNull();
    }
  });

  it("FK compuestas con tenant_id: cliente(tenant_id, id) y membresia(tenant_id, usuario_id)", async () => {
    const r = await consulta(
      `select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = to_regclass('public.job_registro') and contype = 'f'`,
    );
    const defs = r.map((x) => String(x.def).replace(/\s+/g, " "));
    expect(
      defs.some((d) =>
        /FOREIGN KEY \(tenant_id, cliente_id\) REFERENCES cliente\(tenant_id, id\)/.test(
          d,
        ),
      ),
    ).toBe(true);
    expect(
      defs.some((d) =>
        /FOREIGN KEY \(tenant_id, creado_por\) REFERENCES membresia\(tenant_id, usuario_id\)/.test(
          d,
        ),
      ),
    ).toBe(true);
  });

  it("indice unico parcial de dedupe (tenant_id, clave_dedupe) solo con estados vivos, y los dos indices de consulta", async () => {
    const r = await consulta(
      `select indexdef from pg_indexes where schemaname = 'public' and tablename = 'job_registro'`,
    );
    const defs = r.map((x) => String(x.indexdef).replace(/\s+/g, " "));
    const dedupe = defs.filter(
      (d) => /UNIQUE/.test(d) && /\(tenant_id, clave_dedupe\)/.test(d),
    );
    expect(dedupe, "indice unico de dedupe").toHaveLength(1);
    expect(dedupe[0]).toMatch(/WHERE/i);
    expect(dedupe[0]).toContain("en_cola");
    expect(dedupe[0]).toContain("ejecutando");
    for (const e of ["completado", "error", "cancelado"])
      expect(dedupe[0]).not.toContain(e);
    expect(
      defs.some((d) =>
        d.includes("(tenant_id, cola, estado, prioridad, creado_en)"),
      ),
    ).toBe(true);
    expect(
      defs.some((d) => d.includes("(tenant_id, cliente_id, creado_en DESC)")),
    ).toBe(true);
  });

  it("PUBLIC no tiene ningun privilegio sobre job_registro ni sobre config_sistema (tabla ni columnas)", async () => {
    for (const t of ["public.job_registro", "public.config_sistema"]) {
      const r = await consulta(
        `select 'tabla' as nivel, a.privilege_type from pg_class c cross join lateral aclexplode(c.relacl) a
          where c.oid = to_regclass($1) and a.grantee = 0
         union all
         select 'columna', a2.privilege_type from pg_attribute at cross join lateral aclexplode(at.attacl) a2
          where at.attrelid = to_regclass($1) and at.attnum > 0 and a2.grantee = 0`,
        [t],
      );
      expect(r, t).toEqual([]);
      expect(
        (await consulta("select to_regclass($1) is not null as v", [t]))[0].v,
        `${t} existe`,
      ).toBe(true);
    }
  });
});

// =================================================================================================
describe("privilegios exactos de job_registro por rol y columna (CA-15, D2)", () => {
  it("contapp_backend: SELECT de todas las columnas, INSERT, UPDATE solo de estado, motivo, terminado_en y actualizado_en", async () => {
    expect(
      await columnasConPrivilegio(
        "public.job_registro",
        "contapp_backend",
        "SELECT",
      ),
    ).toEqual(COLUMNAS_JOB);
    expect(
      await tieneAlguna("public.job_registro", "contapp_backend", "INSERT"),
    ).toBe(true);
    expect(
      await columnasConPrivilegio(
        "public.job_registro",
        "contapp_backend",
        "UPDATE",
      ),
    ).toEqual(["actualizado_en", "estado", "motivo", "terminado_en"].sort());
  });

  it("contapp_backend: sin DELETE, TRUNCATE, REFERENCES ni TRIGGER", async () => {
    for (const p of ["DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
      expect(
        await tienePrivTabla("public.job_registro", "contapp_backend", p),
        p,
      ).toBe(false);
    }
    expect(
      await tieneAlguna("public.job_registro", "contapp_backend", "REFERENCES"),
    ).toBe(false);
  });

  it("contapp_worker: SELECT de todo, DELETE de tabla y UPDATE solo de las 8 columnas del ejecutor (sin intentos del backend)", async () => {
    expect(
      await columnasConPrivilegio(
        "public.job_registro",
        "contapp_worker",
        "SELECT",
      ),
    ).toEqual(COLUMNAS_JOB);
    expect(
      await tienePrivTabla("public.job_registro", "contapp_worker", "DELETE"),
    ).toBe(true);
    expect(
      await columnasConPrivilegio(
        "public.job_registro",
        "contapp_worker",
        "UPDATE",
      ),
    ).toEqual(
      [
        "actualizado_en",
        "disponible_desde",
        "estado",
        "intentos",
        "iniciado_en",
        "motivo",
        "resultado",
        "terminado_en",
      ].sort(),
    );
  });

  it("contapp_worker: sin INSERT (ni de tabla ni de columna), TRUNCATE, REFERENCES ni TRIGGER", async () => {
    expect(
      await tieneAlguna("public.job_registro", "contapp_worker", "INSERT"),
    ).toBe(false);
    for (const p of ["INSERT", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
      expect(
        await tienePrivTabla("public.job_registro", "contapp_worker", p),
        p,
      ).toBe(false);
    }
    expect(
      await tieneAlguna("public.job_registro", "contapp_worker", "REFERENCES"),
    ).toBe(false);
  });

  it.each(["contapp_platform", "contapp_app"])(
    "%s no tiene ningun privilegio sobre job_registro (tabla ni columna)",
    async (rol) => {
      expect(await concedidos("public.job_registro", rol)).toEqual([]);
      expect(
        (await columnasConPrivilegio("public.job_registro", rol, "SELECT"))
          .length,
      ).toBe(0);
    },
  );

  it("la ACL de job_registro nombra solo a contapp_backend, contapp_worker y contapp_enumerador (ni PUBLIC ni otros roles)", async () => {
    const r = await consulta(
      `select distinct case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as quien
         from pg_class c cross join lateral aclexplode(c.relacl) a
        where c.oid = to_regclass('public.job_registro') and a.grantee <> c.relowner
       union
       select distinct case when a2.grantee = 0 then 'PUBLIC' else a2.grantee::regrole::text end
         from pg_attribute at cross join lateral aclexplode(at.attacl) a2 join pg_class c2 on c2.oid = at.attrelid
        where at.attrelid = to_regclass('public.job_registro') and at.attnum > 0 and a2.grantee <> c2.relowner
        order by 1`,
    );
    expect(r.map((x) => x.quien)).toEqual([
      "contapp_backend",
      "contapp_enumerador",
      "contapp_worker",
    ]);
  });
});

// =================================================================================================
describe("config_sistema: tabla de plataforma, sin escritura de la app (CA-4, CA-15)", () => {
  const COLUMNAS = [
    "actualizado_en",
    "backoff_base_ms",
    "cola",
    "concurrencia_global",
    "concurrencia_tenant",
    "espera_ruc_ms",
    "max_pendientes_tenant",
    "reintentos",
  ];

  it("existe con las columnas del plan, dueño contapp_migrator y SIN tenant_id (no entra al catalogo de RLS)", async () => {
    const r = await consulta(
      `select a.attname from pg_attribute a where a.attrelid = to_regclass('public.config_sistema') and a.attnum > 0 and not a.attisdropped order by 1`,
    );
    expect(r.map((x) => x.attname)).toEqual(COLUMNAS);
    const d = await consulta(
      "select o.rolname from pg_class c join pg_roles o on o.oid = c.relowner where c.oid = to_regclass('public.config_sistema')",
    );
    expect(d[0].rolname).toBe("contapp_migrator");
  });

  it("cola es la clave primaria", async () => {
    const r = await consulta(
      `select a.attname from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
        where i.indrelid = to_regclass('public.config_sistema') and i.indisprimary`,
    );
    expect(r.map((x) => x.attname)).toEqual(["cola"]);
  });

  it.each(["contapp_backend", "contapp_worker"])(
    "%s: SELECT de todas las columnas y nada mas (sin INSERT, UPDATE, DELETE, TRUNCATE)",
    async (rol) => {
      expect(
        await columnasConPrivilegio("public.config_sistema", rol, "SELECT"),
      ).toEqual(COLUMNAS);
      expect(await concedidos("public.config_sistema", rol)).toEqual([
        "SELECT",
      ]);
      for (const p of ["INSERT", "UPDATE", "REFERENCES"])
        expect(
          await tieneAlguna("public.config_sistema", rol, p),
          `${rol} ${p}`,
        ).toBe(false);
    },
  );

  it.each(["contapp_platform", "contapp_app"])(
    "%s no tiene ningun privilegio sobre config_sistema",
    async (rol) => {
      expect(await concedidos("public.config_sistema", rol)).toEqual([]);
    },
  );

  it("la app no puede escribir ni leer config_sistema con el rol de login (42501)", async () => {
    const r = await intentarRaw(pool, null, "select * from config_sistema");
    expect(r.ok ? "ok" : r.code).toBe("42501");
  });

  it("la ACL de config_sistema nombra solo a contapp_backend y contapp_worker (ni PUBLIC ni otros roles)", async () => {
    const r = await consulta(
      `select distinct case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as quien
         from pg_class c cross join lateral aclexplode(c.relacl) a
        where c.oid = to_regclass('public.config_sistema') and a.grantee <> c.relowner order by 1`,
    );
    expect(r.map((x) => x.quien)).toEqual([
      "contapp_backend",
      "contapp_worker",
    ]);
  });
});

// =================================================================================================
describe("credencial.estado (D13): columnas, grants por columna y trigger (CA-9)", () => {
  it("credencial gana estado text NOT NULL DEFAULT 'configurada', estado_motivo text NULL y estado_at timestamptz NULL", async () => {
    const r = await consulta(
      `select column_name, udt_name, is_nullable, column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'credencial' and column_name in ('estado', 'estado_motivo', 'estado_at') order by 1`,
    );
    expect(r).toHaveLength(3);
    const por = Object.fromEntries(r.map((x) => [x.column_name, x]));
    expect([por.estado.udt_name, por.estado.is_nullable]).toEqual([
      "text",
      "NO",
    ]);
    expect(String(por.estado.column_default)).toContain("configurada");
    expect([por.estado_motivo.udt_name, por.estado_motivo.is_nullable]).toEqual(
      ["text", "YES"],
    );
    expect([por.estado_at.udt_name, por.estado_at.is_nullable]).toEqual([
      "timestamptz",
      "YES",
    ]);
  });

  it("contapp_backend LEE las 3 columnas de estado y no las escribe (ni INSERT ni UPDATE)", async () => {
    for (const c of ["estado", "estado_motivo", "estado_at"]) {
      const r = await consulta(
        `select has_column_privilege('contapp_backend', to_regclass('public.credencial'), $1, 'SELECT') as s,
                has_column_privilege('contapp_backend', to_regclass('public.credencial'), $1, 'INSERT') as i,
                has_column_privilege('contapp_backend', to_regclass('public.credencial'), $1, 'UPDATE') as u`,
        [c],
      );
      expect(r[0], c).toEqual({ s: true, i: false, u: false });
    }
  });

  it("contapp_worker ESCRIBE las 3 (UPDATE) pero no las inserta; su UPDATE total son 6 columnas", async () => {
    expect(
      await columnasConPrivilegio(
        "public.credencial",
        "contapp_worker",
        "UPDATE",
      ),
    ).toEqual(
      [
        "dek_envuelta",
        "estado",
        "estado_at",
        "estado_motivo",
        "kek_id",
        "updated_at",
      ].sort(),
    );
    expect(
      await columnasConPrivilegio(
        "public.credencial",
        "contapp_worker",
        "INSERT",
      ),
    ).toEqual([]);
  });

  it("trigger credencial_reinicia_estado: BEFORE UPDATE OF ciphertext, por fila, SECURITY INVOKER, search_path fijo, fuera de `auth`", async () => {
    const t = await consulta(
      `select t.tgname, t.tgtype, t.tgfoid::regproc::text as funcion, p.prosecdef, p.proconfig, n.nspname as esquema,
              (select array_agg(a.attname::text order by a.attname) from pg_attribute a where a.attrelid = t.tgrelid and a.attnum = any(t.tgattr)) as columnas
         from pg_trigger t join pg_proc p on p.oid = t.tgfoid join pg_namespace n on n.oid = p.pronamespace
        where t.tgrelid = to_regclass('public.credencial') and not t.tgisinternal and t.tgname = 'credencial_reinicia_estado'`,
    );
    expect(t).toHaveLength(1);
    const tgtype = Number(t[0].tgtype);
    expect(tgtype & 1, "FOR EACH ROW").toBe(1);
    expect(tgtype & 2, "BEFORE").toBe(2);
    expect(tgtype & 16, "UPDATE").toBe(16);
    expect(tgtype & (4 | 8 | 32), "ni INSERT, DELETE ni TRUNCATE").toBe(0);
    expect(t[0].columnas).toEqual(["ciphertext"]);
    expect(t[0].prosecdef).toBe(false);
    expect(t[0].esquema).not.toBe("auth");
    const sp = (t[0].proconfig as string[] | null)?.find((x) =>
      x.startsWith("search_path="),
    );
    expect(sp, "search_path fijo").toBeDefined();
  });
});

// =================================================================================================
describe("rol contapp_enumerador (D18)", () => {
  it("existe, NOLOGIN, BYPASSRLS, NOINHERIT, sin superusuario, CREATEROLE ni CREATEDB", async () => {
    const r = await consulta(
      `select rolcanlogin, rolsuper, rolbypassrls, rolinherit, rolcreaterole, rolcreatedb, rolreplication
         from pg_roles where rolname = 'contapp_enumerador'`,
    );
    expect(r).toEqual([
      {
        rolcanlogin: false,
        rolsuper: false,
        rolbypassrls: true,
        rolinherit: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
      },
    ]);
  });

  it("nadie lo asume: sin miembros (pg_auth_members) y no es miembro de ningun rol", async () => {
    const miembros = await consulta(
      `select m.member::regrole::text as quien from pg_auth_members m where m.roleid = 'contapp_enumerador'::regrole`,
    );
    expect(miembros).toEqual([]);
    const membresias = await consulta(
      `select m.roleid::regrole::text as rol from pg_auth_members m where m.member = 'contapp_enumerador'::regrole`,
    );
    expect(membresias).toEqual([]);
  });

  it("contapp_app no puede asumirlo (SET ROLE -> 42501)", async () => {
    // intentarRaw lanza si el SET ROLE falla (ocurre antes de capturar la sentencia): se comprueba el SQLSTATE del rechazo.
    await expect(
      intentarRaw(pool, "contapp_enumerador", "select 1"),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("solo tiene SELECT (id) ON tenant y SELECT (tenant_id, estado, actualizado_en) ON job_registro; nada mas en ninguna tabla", async () => {
    const r = await consulta(
      `select n.nspname || '.' || c.relname || '.' || a.attname as col, p.priv
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace and n.nspname in ('public', 'auth', 'sistema')
         join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
         cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) as p(priv)
        where c.relkind in ('r', 'p') and has_column_privilege('contapp_enumerador', c.oid, a.attname, p.priv)
        order by 1, 2`,
    );
    expect(r.map((x) => `${x.priv}:${x.col}`)).toEqual(
      [
        "SELECT:public.job_registro.actualizado_en",
        "SELECT:public.job_registro.estado",
        "SELECT:public.job_registro.tenant_id",
        "SELECT:public.tenant.id",
      ].sort(),
    );
    const tablas = await consulta(
      `select c.relname, p.priv from pg_class c cross join (values ('DELETE'), ('TRUNCATE'), ('TRIGGER')) as p(priv)
        where c.relnamespace in ('public'::regnamespace, 'auth'::regnamespace) and c.relkind in ('r', 'p')
          and has_table_privilege('contapp_enumerador', c.oid, p.priv)`,
    );
    expect(tablas).toEqual([]);
  });

  it("no es dueño de tablas, y solo es dueño de las funciones sistema.*", async () => {
    const tablas = await consulta(
      "select relname from pg_class where relowner = 'contapp_enumerador'::regrole and relkind in ('r', 'p', 'v', 'm')",
    );
    expect(tablas).toEqual([]);
    const fn = await consulta(
      `select n.nspname || '.' || p.proname as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.proowner = 'contapp_enumerador'::regrole order by 1`,
    );
    expect(fn.map((x) => x.f)).toEqual([
      "sistema.estudios_con_trabajos",
      "sistema.estudios_ids",
    ]);
  });
});

// =================================================================================================
describe("esquema sistema y sus funciones (D18, CA-12)", () => {
  it("el esquema sistema existe, es de contapp_migrator y solo contapp_worker tiene USAGE (nadie crea objetos)", async () => {
    const d = await consulta(
      "select o.rolname from pg_namespace n join pg_roles o on o.oid = n.nspowner where n.nspname = 'sistema'",
    );
    expect(d).toEqual([{ rolname: "contapp_migrator" }]);
    expect(
      (
        await consulta(
          "select has_schema_privilege('contapp_worker', 'sistema', 'USAGE') as v",
        )
      )[0].v,
    ).toBe(true);
    for (const rol of ["contapp_backend", "contapp_platform", "contapp_app"]) {
      expect(
        (
          await consulta(
            "select has_schema_privilege($1, 'sistema', 'USAGE') as v",
            [rol],
          )
        )[0].v,
        `${rol} USAGE`,
      ).toBe(false);
    }
    for (const rol of [
      "contapp_backend",
      "contapp_worker",
      "contapp_platform",
      "contapp_app",
    ]) {
      expect(
        (
          await consulta(
            "select has_schema_privilege($1, 'sistema', 'CREATE') as v",
            [rol],
          )
        )[0].v,
        `${rol} CREATE`,
      ).toBe(false);
    }
    const publico = await consulta(
      `select 1 from pg_namespace n cross join lateral aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
        where n.nspname = 'sistema' and a.grantee = 0`,
    );
    expect(publico, "PUBLIC sin privilegios en el esquema").toEqual([]);
  });

  it("contiene exactamente estudios_ids() y estudios_con_trabajos(text[], integer)", async () => {
    const r = await consulta(
      `select p.proname, pg_get_function_identity_arguments(p.oid) as args from pg_proc p
        where p.pronamespace = to_regnamespace('sistema') order by 1`,
    );
    expect(r).toEqual([
      {
        proname: "estudios_con_trabajos",
        args: "estados text[], antiguedad_seg integer",
      },
      { proname: "estudios_ids", args: "" },
    ]);
  });

  it("SECURITY DEFINER, dueño contapp_enumerador, STABLE, SETOF uuid y search_path = pg_catalog, pg_temp", async () => {
    const r = await consulta(
      `select p.proname, p.prosecdef, o.rolname as dueno, p.provolatile, p.proretset, p.prorettype::regtype::text as retorna, p.proconfig
         from pg_proc p join pg_roles o on o.oid = p.proowner where p.pronamespace = to_regnamespace('sistema') order by 1`,
    );
    expect(r).toHaveLength(2);
    for (const f of r) {
      expect(f.prosecdef, `${f.proname} prosecdef`).toBe(true);
      expect(f.dueno, `${f.proname} dueno`).toBe("contapp_enumerador");
      expect(f.provolatile, `${f.proname} STABLE`).toBe("s");
      expect(f.proretset, `${f.proname} SETOF`).toBe(true);
      expect(f.retorna, `${f.proname} devuelve solo uuid`).toBe("uuid");
      const sp = (f.proconfig as string[] | null)?.find((x) =>
        x.startsWith("search_path="),
      );
      expect(sp, `${f.proname} search_path`).toMatch(
        /^search_path=pg_catalog,\s*pg_temp$/,
      );
    }
  });

  it("EXECUTE solo para contapp_worker: ni PUBLIC, ni backend, ni platform, ni contapp_app", async () => {
    const r = await consulta(
      `select p.proname,
              has_function_privilege('contapp_worker', p.oid, 'EXECUTE') as worker,
              has_function_privilege('contapp_backend', p.oid, 'EXECUTE') as backend,
              has_function_privilege('contapp_platform', p.oid, 'EXECUTE') as platform,
              has_function_privilege('contapp_app', p.oid, 'EXECUTE') as app,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) as publico
         from pg_proc p where p.pronamespace = to_regnamespace('sistema') order by 1`,
    );
    expect(r).toHaveLength(2);
    for (const f of r) {
      expect(
        [f.worker, f.backend, f.platform, f.app, f.publico],
        f.proname,
      ).toEqual([true, false, false, false, false]);
    }
  });
});

// =================================================================================================
describe("auth.purgar (D16, CA-13): catalogo", () => {
  const firma = `p.pronamespace = to_regnamespace('auth') and p.proname = 'purgar'`;

  it("una sola firma: (interval, interval, interval, interval) -> TABLE(sesiones, tokens, intentos, limites) enteros", async () => {
    const r = await consulta(
      `select pg_get_function_identity_arguments(p.oid) as args, pg_get_function_result(p.oid) as retorna from pg_proc p where ${firma}`,
    );
    expect(r).toEqual([
      {
        args: "retencion_sesion interval, retencion_token interval, retencion_intento interval, retencion_limite interval",
        retorna:
          "TABLE(sesiones integer, tokens integer, intentos integer, limites integer)",
      },
    ]);
  });

  it("SECURITY DEFINER, dueño contapp_auth y search_path fijo a pg_catalog, pg_temp", async () => {
    const r = await consulta(
      `select p.prosecdef, o.rolname as dueno, p.proconfig from pg_proc p join pg_roles o on o.oid = p.proowner where ${firma}`,
    );
    expect(r).toHaveLength(1);
    expect(r[0].prosecdef).toBe(true);
    expect(r[0].dueno).toBe("contapp_auth");
    const sp = (r[0].proconfig as string[] | null)?.find((x) =>
      x.startsWith("search_path="),
    );
    expect(sp).toMatch(/^search_path=pg_catalog,\s*pg_temp$/);
  });

  it("EXECUTE solo para contapp_worker (y el dueño): ni PUBLIC, ni backend, ni platform, ni contapp_app", async () => {
    const r = await consulta(
      `select has_function_privilege('contapp_worker', p.oid, 'EXECUTE') as worker,
              has_function_privilege('contapp_backend', p.oid, 'EXECUTE') as backend,
              has_function_privilege('contapp_platform', p.oid, 'EXECUTE') as platform,
              has_function_privilege('contapp_app', p.oid, 'EXECUTE') as app,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) as publico
         from pg_proc p where ${firma}`,
    );
    expect(r).toEqual([
      {
        worker: true,
        backend: false,
        platform: false,
        app: false,
        publico: false,
      },
    ]);
  });

  it("contapp_worker tiene USAGE del esquema auth solo si lo necesita para llamar a purgar (y no puede crear objetos ahi)", async () => {
    expect(
      (
        await consulta(
          "select has_schema_privilege('contapp_worker', 'auth', 'USAGE') as v",
        )
      )[0].v,
    ).toBe(true);
    expect(
      (
        await consulta(
          "select has_schema_privilege('contapp_worker', 'auth', 'CREATE') as v",
        )
      )[0].v,
    ).toBe(false);
  });

  it("contapp_worker sigue sin ningun privilegio de tabla sobre las tablas de auth (solo EXECUTE de purgar)", async () => {
    for (const t of [
      "usuario_contrasena",
      "sesion",
      "token_recuperacion",
      "intento_login",
      "limite_tasa",
    ]) {
      expect(
        await concedidos(`auth.${t}`, "contapp_worker"),
        `worker sobre auth.${t}`,
      ).toEqual([]);
    }
  });
});

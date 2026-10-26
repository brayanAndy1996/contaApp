// Spec 004 (T5, rojo): privilegios y catalogo del esquema `auth` (CA-6, CA-11, D10).
// Contrato que fija (T9, migracion 0007_auth.sql):
// - rol contapp_auth NOLOGIN sin BYPASSRLS ni superusuario; esquema `auth`; 5 tablas (dueno contapp_migrator)
//   con RLS ENABLE+FORCE y una sola politica `auth_definer FOR ALL TO contapp_auth USING (true) WITH CHECK (true)`.
// - privilegios de tabla solo para contapp_auth; el backend (y nadie mas) ejecuta las 11 funciones auth.*.
// - funciones SECURITY DEFINER, dueno contapp_auth, search_path = pg_catalog, pg_temp.
// - usuario.email: CHECK (btrim, lower, NFC) e indice unico sobre lower(email).
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FUNCIONES_AUTH, ROLES_SIN_ACCESO, TABLAS_AUTH, abrirAdmin } from "./auth-soporte";
import { abrirPool, intentarRaw, semilla } from "./soporte";

let pool: Pool; // contapp_app (DATABASE_URL)
let admin: Pool; // superusuario (solo para escrituras con rollback de las pruebas de CHECK)
beforeAll(() => {
  pool = abrirPool(3);
  admin = abrirAdmin(2);
});
afterAll(async () => {
  await pool?.end();
  await admin?.end();
});

const PRIVS_TABLA = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"] as const;

// Catalogo: con el rol administrativo (contapp_app no tiene USAGE sobre `auth`, y to_regclass devolveria NULL).
async function consulta(text: string, values: unknown[] = []) {
  return (await admin.query(text, values)).rows;
}

describe("esquema auth: tablas, dueno y RLS", () => {
  it("existe el esquema auth y las 5 tablas del plan", async () => {
    const r = await consulta(
      `select c.relname from pg_class c where c.relnamespace = to_regnamespace('auth') and c.relkind = 'r' order by 1`,
    );
    expect(r.map((x) => x.relname)).toEqual([...TABLAS_AUTH].sort());
  });

  it.each(TABLAS_AUTH)("%s: dueno contapp_migrator, RLS ENABLE+FORCE", async (t) => {
    const r = await consulta(
      `select o.rolname as dueno, c.relrowsecurity as rls, c.relforcerowsecurity as forzada
         from pg_class c join pg_roles o on o.oid = c.relowner where c.oid = to_regclass($1)`,
      [`auth.${t}`],
    );
    expect(r).toEqual([{ dueno: "contapp_migrator", rls: true, forzada: true }]);
  });

  it.each(TABLAS_AUTH)("%s: una sola politica, auth_definer FOR ALL TO contapp_auth con USING y WITH CHECK (true)", async (t) => {
    const r = await consulta(
      `select policyname, cmd, roles::text[] as roles, qual, with_check from pg_policies
        where schemaname = 'auth' and tablename = $1`,
      [t],
    );
    expect(r).toHaveLength(1);
    expect(r[0].policyname).toBe("auth_definer");
    expect(r[0].cmd).toBe("ALL");
    expect(r[0].roles).toEqual(["contapp_auth"]);
    expect(r[0].qual).toBe("true");
    expect(r[0].with_check).toBe("true");
  });

  it.each(["usuario", "tenant", "membresia"])("RLS sigue activa y forzada en public.%s (CA-11)", async (t) => {
    const r = await consulta(
      "select c.relrowsecurity as rls, c.relforcerowsecurity as forzada from pg_class c where c.oid = to_regclass($1)",
      [`public.${t}`],
    );
    expect(r).toEqual([{ rls: true, forzada: true }]);
  });
});

describe("rol contapp_auth", () => {
  it("existe, NOLOGIN, sin superusuario, sin BYPASSRLS y sin CREATEROLE/CREATEDB", async () => {
    const r = await consulta(
      `select rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb from pg_roles where rolname = 'contapp_auth'`,
    );
    expect(r).toEqual([
      { rolcanlogin: false, rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false },
    ]);
  });

  it("solo lee usuario y membresia del esquema public (SELECT, sin escribir) y nada de cliente/credencial", async () => {
    const tiene = async (t: string, p: string) =>
      (await consulta("select has_table_privilege('contapp_auth', to_regclass($1), $2) as v", [`public.${t}`, p]))[0].v;
    expect(await tiene("usuario", "SELECT")).toBe(true);
    expect(await tiene("membresia", "SELECT")).toBe(true);
    for (const t of ["usuario", "membresia", "tenant", "cliente", "credencial"]) {
      for (const p of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
        expect(await tiene(t, p), `${t} ${p}`).toBe(false);
      }
    }
    for (const t of ["cliente", "credencial", "auditoria_descifrado"]) {
      expect(await tiene(t, "SELECT"), `${t} SELECT`).toBe(false);
    }
  });

  it("las politicas de lectura de usuario y membresia para contapp_auth son solo SELECT (auth_definer)", async () => {
    const r = await consulta(
      `select tablename, cmd, roles::text[] as roles, qual from pg_policies
        where schemaname = 'public' and policyname = 'auth_definer' order by tablename`,
    );
    expect(r.map((x) => x.tablename)).toEqual(["membresia", "usuario"]);
    for (const p of r) {
      expect(p.cmd).toBe("SELECT");
      expect(p.roles).toEqual(["contapp_auth"]);
      expect(p.qual).toBe("true");
    }
  });
});

describe("CA-11 privilegios de tabla en auth.*", () => {
  it.each(TABLAS_AUTH)("%s: solo contapp_auth (y el dueno) tiene privilegios de tabla o de columna", async (t) => {
    const r = await consulta(
      `select distinct case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as quien
         from pg_class c cross join lateral aclexplode(c.relacl) a
        where c.oid = to_regclass($1) and a.grantee <> c.relowner
       union
       select distinct case when a2.grantee = 0 then 'PUBLIC' else a2.grantee::regrole::text end
         from pg_attribute at cross join lateral aclexplode(at.attacl) a2
         join pg_class c2 on c2.oid = at.attrelid
        where at.attrelid = to_regclass($1) and at.attnum > 0 and a2.grantee <> c2.relowner
        order by 1`,
      [`auth.${t}`],
    );
    expect(r.map((x) => x.quien)).toEqual(["contapp_auth"]);
  });

  it.each(TABLAS_AUTH)("%s: contapp_auth puede SELECT, INSERT y UPDATE (las funciones lo necesitan)", async (t) => {
    for (const p of ["SELECT", "INSERT", "UPDATE"]) {
      const r = await consulta("select has_table_privilege('contapp_auth', to_regclass($1), $2) as v", [`auth.${t}`, p]);
      expect(r[0].v, `${t} ${p}`).toBe(true);
    }
  });

  it.each(ROLES_SIN_ACCESO.flatMap((rol) => TABLAS_AUTH.map((t) => [rol, t] as const)))(
    "%s no tiene ningun privilegio sobre auth.%s",
    async (rol, t) => {
      for (const p of PRIVS_TABLA) {
        const r = await consulta("select has_table_privilege($1, to_regclass($2), $3) as v", [rol, `auth.${t}`, p]);
        expect(r[0].v, `${rol} ${p}`).toBe(false);
      }
      for (const p of ["SELECT", "INSERT", "UPDATE", "REFERENCES"]) {
        const r = await consulta("select has_any_column_privilege($1, to_regclass($2), $3) as v", [rol, `auth.${t}`, p]);
        expect(r[0].v, `${rol} ${p} (columna)`).toBe(false);
      }
    },
  );

  it("el backend puede usar el esquema (USAGE) pero ningun rol de la app puede crear objetos en el", async () => {
    const usage = await consulta("select has_schema_privilege('contapp_backend', 'auth', 'USAGE') as v");
    expect(usage[0].v).toBe(true);
    for (const rol of ROLES_SIN_ACCESO) {
      const r = await consulta("select has_schema_privilege($1, 'auth', 'CREATE') as v", [rol]);
      expect(r[0].v, `${rol} CREATE en auth`).toBe(false);
    }
  });
});

const ACTUALIZAR: Record<(typeof TABLAS_AUTH)[number], string> = {
  usuario_contrasena: "set actualizada_en = now()",
  sesion: "set revocada_en = null",
  token_recuperacion: "set usado_en = null",
  intento_login: "set fallos = 0",
  limite_tasa: "set conteo = 0",
};

describe("CA-11 contapp_backend no toca las tablas de auth por ninguna via SQL (42501)", () => {
  const casos = TABLAS_AUTH.flatMap((t) => [
    [`SELECT * de ${t}`, `select * from auth.${t}`],
    [`SELECT count(*) de ${t}`, `select count(*) from auth.${t}`],
    [`INSERT en ${t}`, `insert into auth.${t} default values`],
    [`UPDATE de ${t}`, `update auth.${t} ${ACTUALIZAR[t]}`],
    [`DELETE de ${t}`, `delete from auth.${t}`],
    [`TRUNCATE de ${t}`, `truncate auth.${t}`],
    [`COPY de ${t}`, `copy auth.${t} to stdout`],
    [`COPY (select) de ${t}`, `copy (select 1 from auth.${t}) to stdout`],
  ]) as [string, string][];

  it.each(casos)("permission denied: %s", async (_n, sql) => {
    const r = await intentarRaw(pool, "contapp_backend", sql);
    expect(r.ok, "la sentencia debio rechazarse").toBe(false);
    expect(r.ok ? "" : r.code).toBe("42501");
  });

  it.each([
    ["token_hash de sesion", "select token_hash from auth.sesion"],
    ["hash de contrasena", "select hash from auth.usuario_contrasena"],
    ["oraculo sobre el hash", "select 1 from auth.usuario_contrasena where hash like '$argon2id$%'"],
    ["token de recuperacion", "select token_hash from auth.token_recuperacion"],
    ["clave de intento_login", "select clave from auth.intento_login"],
    ["JOIN con usuario", "select u.email from usuario u join auth.sesion s on s.usuario_id = u.id"],
  ])("permission denied: %s", async (_n, sql) => {
    const r = await intentarRaw(pool, "contapp_backend", sql);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.code).toBe("42501");
  });
});

describe("CA-11 funciones auth.*: solo contapp_backend ejecuta", () => {
  it("el esquema auth contiene exactamente las funciones del plan (una firma cada una)", async () => {
    const r = await consulta(
      "select p.proname from pg_proc p where p.pronamespace = to_regnamespace('auth') order by 1",
    );
    expect(r.map((x) => x.proname)).toEqual([...FUNCIONES_AUTH].sort());
  });

  it("SECURITY DEFINER, dueno contapp_auth y search_path fijo a pg_catalog, pg_temp", async () => {
    const r = await consulta(
      `select p.proname, p.prosecdef, o.rolname as dueno, p.proconfig
         from pg_proc p join pg_roles o on o.oid = p.proowner
        where p.pronamespace = to_regnamespace('auth') order by 1`,
    );
    expect(r).toHaveLength(FUNCIONES_AUTH.length);
    for (const f of r) {
      expect(f.prosecdef, `${f.proname} prosecdef`).toBe(true);
      expect(f.dueno, `${f.proname} dueno`).toBe("contapp_auth");
      const sp = (f.proconfig as string[] | null)?.find((x) => x.startsWith("search_path="));
      expect(sp, `${f.proname} search_path`).toMatch(/^search_path=pg_catalog,\s*pg_temp$/);
    }
  });

  it("EXECUTE solo para contapp_backend: ni PUBLIC, ni worker, ni platform, ni contapp_app", async () => {
    const r = await consulta(
      `select p.proname,
              has_function_privilege('contapp_backend', p.oid, 'EXECUTE') as backend,
              has_function_privilege('contapp_worker', p.oid, 'EXECUTE') as worker,
              has_function_privilege('contapp_platform', p.oid, 'EXECUTE') as platform,
              has_function_privilege('contapp_app', p.oid, 'EXECUTE') as app,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) as publico
         from pg_proc p where p.pronamespace = to_regnamespace('auth') order by 1`,
    );
    expect(r).toHaveLength(FUNCIONES_AUTH.length);
    for (const f of r) {
      expect(f.backend, `${f.proname} backend`).toBe(true);
      expect(f.worker, `${f.proname} worker`).toBe(false);
      expect(f.platform, `${f.proname} platform`).toBe(false);
      expect(f.app, `${f.proname} contapp_app`).toBe(false);
      expect(f.publico, `${f.proname} PUBLIC`).toBe(false);
    }
  });

  it.each(["contapp_worker", "contapp_platform"])("%s no puede llamar a auth.limite_consumir (42501)", async (rol) => {
    // contapp_app no puede asumir contapp_platform: se asume el rol desde la conexion administrativa.
    const r = await intentarRaw(admin, rol, "select auth.limite_consumir('login_ip', 'sujeto-prueba')");
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.code).toBe("42501");
  });

  it("contapp_app (sin SET ROLE) tampoco puede llamar a auth.sesion_validar (42501)", async () => {
    const r = await intentarRaw(pool, null, "select * from auth.sesion_validar(decode(repeat('00', 32), 'hex'))");
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.code).toBe("42501");
  });
});

describe("usuario.email: CHECK (btrim, lower, NFC) e indice unico sobre lower(email) (D10)", () => {
  const insertar = (email: string) =>
    intentarRaw(admin, null, "insert into usuario (email, nombre) values ($1, 'Prueba T5')", [email]);

  it("acepta un correo normalizado (control: la prueba no es vacua)", async () => {
    const r = await insertar(`control-${Date.now()}@auth.test`);
    expect(r).toEqual({ ok: true, rowCount: 1 });
  });

  it.each([
    ["con mayusculas", "Mayus@auth.test"],
    ["con espacio al inicio", " espacio@auth.test"],
    ["con espacio al final", "espacio@auth.test "],
    ["no NFC (e + acento combinante)", "café@auth.test"],
  ])("rechaza un correo %s con 23514", async (_n, email) => {
    const r = await insertar(email);
    expect(r.ok ? "ok" : r.code).toBe("23514");
  });

  it("existe un indice unico sobre lower(email)", async () => {
    const r = await consulta(
      `select indexdef from pg_indexes where schemaname = 'public' and tablename = 'usuario'
          and indexdef ilike '%unique%' and indexdef ilike '%lower(email%'`,
    );
    expect(r.length).toBeGreaterThanOrEqual(1);
  });
});

describe("CA-6 restricciones CHECK de las tablas de auth (solo hashes de 32 B, formatos cerrados)", () => {
  const uid = () => semilla().uA;
  const bytes = (n: number) => Buffer.alloc(n, 7);
  const phc = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2E$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g";

  const SESION = `insert into auth.sesion (token_hash, usuario_id, creada_en, ultimo_uso, expira_absoluta, motivo)
                  values ($1, $2, now(), now(), now() + interval '12 hours', $3)`;
  const TOKEN = `insert into auth.token_recuperacion (token_hash, usuario_id, creado_en, expira_en)
                 values ($1, $2, now(), now() + interval '30 minutes')`;
  const INTENTO = `insert into auth.intento_login (clave, fallos, ventana_inicio) values ($1, 0, now())`;
  const LIMITE = `insert into auth.limite_tasa (tipo, sujeto, ventana_inicio, conteo) values ($1, 'sujeto-prueba', now(), 1)`;
  const CONTRASENA = `insert into auth.usuario_contrasena (usuario_id, hash, actualizada_en) values ($1, $2, now())`;

  const CONTRASENA_USUARIO_NUEVO = `with u as (insert into usuario (email, nombre) values ('control-contrasena@auth.test', 'Control T5') returning id)
                                   insert into auth.usuario_contrasena (usuario_id, hash, actualizada_en) select id, $1, now() from u`;

  const control: [string, string, () => unknown[]][] = [
    ["sesion", SESION, () => [bytes(32), uid(), null]],
    ["token_recuperacion", TOKEN, () => [bytes(32), uid()]],
    ["intento_login", INTENTO, () => [bytes(32)]],
    ["limite_tasa", LIMITE, () => ["login_ip"]],
    // uA ya tiene credencial en la semilla (usuario_id es PK): el control crea un usuario nuevo y se revierte.
    ["usuario_contrasena", CONTRASENA_USUARIO_NUEVO, () => [phc]],
  ];

  it.each(control)("control: un INSERT valido en %s pasa (la prueba no es vacua)", async (_t, sql, valores) => {
    const r = await intentarRaw(admin, null, sql, valores());
    expect(r).toEqual({ ok: true, rowCount: 1 });
  });

  it.each([
    ["sesion.token_hash de 31 B", SESION, () => [bytes(31), uid(), null]],
    ["sesion.token_hash de 33 B", SESION, () => [bytes(33), uid(), null]],
    ["sesion.motivo fuera de la lista", SESION, () => [bytes(32), uid(), "otro"]],
    ["token_recuperacion.token_hash de 31 B", TOKEN, () => [bytes(31), uid()]],
    ["token_recuperacion.token_hash de 33 B", TOKEN, () => [bytes(33), uid()]],
    ["intento_login.clave de 31 B", INTENTO, () => [bytes(31)]],
    ["intento_login.clave de 33 B", INTENTO, () => [bytes(33)]],
    ["limite_tasa.tipo desconocido", LIMITE, () => ["otro"]],
    ["usuario_contrasena.hash que no es argon2id", CONTRASENA, () => [uid(), "$2b$12$abcdefghijklmnopqrstuv"]],
    ["usuario_contrasena.hash en texto plano", CONTRASENA, () => [uid(), "contrasena-en-claro"]],
    ["usuario_contrasena.hash de mas de 256 caracteres", CONTRASENA, () => [uid(), `$argon2id$${"a".repeat(250)}`]],
  ])("rechaza %s con 23514", async (_n, sql, valores) => {
    const r = await intentarRaw(admin, null, sql, valores());
    expect(r.ok ? "ok" : r.code).toBe("23514");
  });

  it("sesion.token_hash es UNIQUE (23505) y la fila exige un usuario existente (23503)", async () => {
    const c = await admin.connect();
    try {
      await c.query("BEGIN");
      await c.query(SESION, [bytes(32), uid(), null]);
      const dup = await c.query("SAVEPOINT s1").then(() => c.query(SESION, [bytes(32), uid(), null])).catch((e) => e);
      expect((dup as { code?: string }).code).toBe("23505");
      await c.query("ROLLBACK TO SAVEPOINT s1");
      const sinUsuario = await c
        .query(SESION, [Buffer.alloc(32, 9), "01920000-0000-7000-8000-00000000ffff", null])
        .catch((e) => e);
      expect((sinUsuario as { code?: string }).code).toBe("23503");
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  });
});

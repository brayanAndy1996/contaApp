// Spec 029 (T1, rojo hasta 0078) · CA-7: tablas, columnas, grants y catalogo de las funciones de la cuenta segura.
// Contrato en `auth-totp-soporte.ts`. Rojo por: las tablas, columnas y funciones aun no existen.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FUNCIONES_AUTH_CUENTA, FUNCIONES_AUTH_SOLO_MIGRATOR, ROLES_SIN_ACCESO, TABLAS_AUTH_CUENTA, abrirAdmin } from "./auth-soporte";
import { TIPOS_EVENTO } from "./auth-totp-soporte";

let admin: Pool;
beforeAll(() => {
  admin = abrirAdmin(3);
});
afterAll(async () => {
  await admin?.end();
});
const q = async (sql: string, v: unknown[] = []) => (await admin.query(sql, v)).rows;
const PRIVS = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"] as const;

describe("tablas nuevas de auth: dueño, RLS, una politica y grants solo a contapp_auth", () => {
  it.each(TABLAS_AUTH_CUENTA)("%s: existe, dueño contapp_migrator, RLS ENABLE+FORCE", async (t) => {
    const r = await q(
      `select o.rolname as dueno, c.relrowsecurity as rls, c.relforcerowsecurity as forzada
         from pg_class c join pg_roles o on o.oid = c.relowner where c.oid = to_regclass($1)`,
      [`auth.${t}`],
    );
    expect(r, `auth.${t} no existe (0078 pendiente)`).toEqual([{ dueno: "contapp_migrator", rls: true, forzada: true }]);
  });

  it.each(TABLAS_AUTH_CUENTA)("%s: una sola politica, auth_definer FOR ALL TO contapp_auth", async (t) => {
    const r = await q(
      `select policyname, cmd, roles::text[] as roles, qual, with_check from pg_policies where schemaname = 'auth' and tablename = $1`,
      [t],
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ policyname: "auth_definer", cmd: "ALL", roles: ["contapp_auth"], qual: "true", with_check: "true" });
  });

  it.each(TABLAS_AUTH_CUENTA)("%s: solo contapp_auth (y el dueño) tiene privilegios de tabla o de columna", async (t) => {
    const r = await q(
      `select distinct case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as quien
         from pg_class c cross join lateral aclexplode(c.relacl) a
        where c.oid = to_regclass($1) and a.grantee <> c.relowner
       union
       select distinct case when a2.grantee = 0 then 'PUBLIC' else a2.grantee::regrole::text end
         from pg_attribute at cross join lateral aclexplode(at.attacl) a2 join pg_class c2 on c2.oid = at.attrelid
        where at.attrelid = to_regclass($1) and at.attnum > 0 and a2.grantee <> c2.relowner order by 1`,
      [`auth.${t}`],
    );
    expect(r.map((x) => x.quien)).toEqual(["contapp_auth"]);
  });

  it.each(ROLES_SIN_ACCESO.flatMap((rol) => TABLAS_AUTH_CUENTA.map((t) => [rol, t] as const)))(
    "%s no tiene ningun privilegio sobre auth.%s (ni la lee con SELECT)",
    async (rol, t) => {
      for (const p of PRIVS) {
        const r = await q("select has_table_privilege($1, to_regclass($2), $3) as v", [rol, `auth.${t}`, p]);
        expect(r[0].v, `${rol} ${p}`).toBe(false);
      }
      for (const p of ["SELECT", "INSERT", "UPDATE", "REFERENCES"]) {
        const r = await q("select has_any_column_privilege($1, to_regclass($2), $3) as v", [rol, `auth.${t}`, p]);
        expect(r[0].v, `${rol} ${p} (columna)`).toBe(false);
      }
    },
  );

  it("contapp_auth: TOTP y codigos se leen, escriben y borran; cuenta_evento solo se agrega; TRUNCATE en ninguna", async () => {
    const tiene = async (t: string, p: string) =>
      (await q("select has_table_privilege('contapp_auth', to_regclass($1), $2) as v", [`auth.${t}`, p]))[0].v;
    for (const t of ["totp", "totp_recuperacion"]) for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) expect(await tiene(t, p), `${t} ${p}`).toBe(true);
    expect(await tiene("cuenta_evento", "SELECT")).toBe(true);
    expect(await tiene("cuenta_evento", "INSERT")).toBe(true);
    // un evento es un hecho: nadie lo edita ni lo borra con las funciones (el borrado de un usuario es administrativo)
    expect(await tiene("cuenta_evento", "UPDATE")).toBe(false);
    for (const t of TABLAS_AUTH_CUENTA) expect(await tiene(t, "TRUNCATE"), `${t} TRUNCATE`).toBe(false);
  });

  it("contapp_backend no toca las tablas por ninguna via SQL (42501): ni el secreto cifrado ni los hashes", async () => {
    for (const sql of [
      "select activo_cifrado from auth.totp",
      "select * from auth.totp",
      "select hash from auth.totp_recuperacion",
      "select count(*) from auth.totp_recuperacion",
      "select tipo from auth.cuenta_evento",
      "update auth.totp set ultimo_paso = 0",
      "delete from auth.totp_recuperacion",
      "insert into auth.cuenta_evento (usuario_id, tipo) select id, 'totp_activado' from usuario",
    ]) {
      const c = await admin.connect();
      try {
        await c.query("BEGIN");
        await c.query("SET LOCAL ROLE contapp_backend");
        await c.query(sql);
        expect.fail(`la sentencia debio rechazarse: ${sql}`);
      } catch (e) {
        expect((e as { code?: string }).code, sql).toBe("42501");
      } finally {
        await c.query("ROLLBACK").catch(() => undefined);
        c.release();
      }
    }
  });
});

describe("columnas y restricciones de 0078", () => {
  it("auth.totp: columnas del plan; usuario_id es PK con FK a usuario; ultimo_paso bigint", async () => {
    const cols = await q(
      `select column_name, data_type, is_nullable from information_schema.columns where table_schema = 'auth' and table_name = 'totp' order by ordinal_position`,
    );
    expect(cols.map((c) => c.column_name)).toEqual([
      "usuario_id",
      "activo_cifrado",
      "activo_version",
      "pendiente_cifrado",
      "pendiente_version",
      "pendiente_expira",
      "ultimo_paso",
      "activado_en",
    ]);
    expect(cols.find((c) => c.column_name === "ultimo_paso")?.data_type).toBe("bigint");
    expect(cols.find((c) => c.column_name === "activo_cifrado")?.data_type).toBe("bytea");
    const fk = await q(
      `select confrelid::regclass::text as destino from pg_constraint where conrelid = to_regclass('auth.totp') and contype = 'f'`,
    );
    expect(fk.map((f) => f.destino)).toEqual(["usuario"]);
    const pk = await q(`select pg_get_constraintdef(oid) as d from pg_constraint where conrelid = to_regclass('auth.totp') and contype = 'p'`);
    expect(pk[0].d).toMatch(/PRIMARY KEY \(usuario_id\)/);
  });

  it("auth.totp_recuperacion: hash bytea UNICO y FK a usuario; un hash repetido da 23505", async () => {
    const cols = await q(
      `select column_name from information_schema.columns where table_schema = 'auth' and table_name = 'totp_recuperacion' order by ordinal_position`,
    );
    expect(cols.map((c) => c.column_name)).toEqual(["id", "usuario_id", "hash", "usado_en"]);
    const u = await q(
      `select pg_get_constraintdef(oid) as d from pg_constraint where conrelid = to_regclass('auth.totp_recuperacion') and contype = 'u'`,
    );
    expect(u.map((x) => x.d).join()).toMatch(/UNIQUE \(hash\)/);
  });

  it("auth.cuenta_evento: tipo con CHECK de los 5 valores y SIN texto libre (solo id, usuario, tipo y fecha)", async () => {
    const cols = await q(
      `select column_name, data_type from information_schema.columns where table_schema = 'auth' and table_name = 'cuenta_evento' order by ordinal_position`,
    );
    expect(cols.map((c) => c.column_name)).toEqual(["id", "usuario_id", "tipo", "creado_en"]);
    const chk = await q(`select pg_get_constraintdef(oid) as d from pg_constraint where conrelid = to_regclass('auth.cuenta_evento') and contype = 'c'`);
    const def = chk.map((c) => c.d).join(" ");
    for (const t of TIPOS_EVENTO) expect(def, t).toContain(`'${t}'`);
    expect(def.match(/'[a-z_]+'/g)).toHaveLength(TIPOS_EVENTO.length);
  });

  it("auth.sesion: factor (default sin_factor, 3 valores), dispositivo <= 60, ip_red cidr y motivos nuevos", async () => {
    const cols = await q(
      `select column_name, data_type, column_default, is_nullable from information_schema.columns
        where table_schema = 'auth' and table_name = 'sesion' and column_name in ('factor', 'dispositivo', 'ip_red')`,
    );
    const por = Object.fromEntries(cols.map((c) => [c.column_name, c]));
    expect(por.factor, "falta auth.sesion.factor").toBeDefined();
    expect(por.factor.is_nullable).toBe("NO");
    expect(String(por.factor.column_default)).toContain("sin_factor");
    expect(por.dispositivo?.data_type).toBe("text");
    expect(por.ip_red?.data_type).toBe("cidr");
    const defs = (await q(`select pg_get_constraintdef(oid) as d from pg_constraint where conrelid = to_regclass('auth.sesion') and contype = 'c'`))
      .map((c) => c.d as string)
      .join(" ");
    for (const f of ["pendiente", "verificado", "sin_factor"]) expect(defs, f).toContain(`'${f}'`);
    for (const m of ["logout", "rotacion", "cerrar_todas", "contrasena", "restablecer", "revocada_usuario", "totp"]) expect(defs, m).toContain(`'${m}'`);
    expect(defs).toMatch(/60/);
  });

  it("auth.sesion: un factor o un motivo fuera de la lista da 23514 y un dispositivo de 61 caracteres tambien", async () => {
    const u = await q("select id from usuario limit 1");
    const intento = async (columna: string, valores: unknown[]) => {
      const c = await admin.connect();
      try {
        await c.query("BEGIN");
        await c.query(
          `insert into auth.sesion (token_hash, usuario_id, expira_absoluta, ${columna}) values (sha256(convert_to(gen_random_uuid()::text, 'UTF8')), $1, now() + interval '1 hour', $2)`,
          [u[0].id, valores[0]],
        );
        return "ok";
      } catch (e) {
        return (e as { code?: string }).code;
      } finally {
        await c.query("ROLLBACK").catch(() => undefined);
        c.release();
      }
    };
    expect(await intento("factor", ["otro"])).toBe("23514");
    expect(await intento("motivo", ["inventado"])).toBe("23514");
    expect(await intento("dispositivo", ["x".repeat(61)])).toBe("23514");
    expect(await intento("dispositivo", ["x".repeat(60)])).toBe("ok");
    expect(await intento("motivo", ["totp"])).toBe("ok");
    expect(await intento("motivo", ["revocada_usuario"])).toBe("ok");
  });
});

describe("funciones de la cuenta segura: catalogo (una firma, DEFINER, dueño contapp_auth, search_path fijo, EXECUTE justo)", () => {
  const catalogo = () =>
    q(
      `select p.proname, p.prosecdef, pg_get_userbyid(p.proowner) as dueno, p.proconfig as config,
              has_function_privilege('contapp_backend', p.oid, 'EXECUTE') as backend,
              has_function_privilege('contapp_migrator', p.oid, 'EXECUTE') as migrator,
              has_function_privilege('contapp_worker', p.oid, 'EXECUTE') as worker,
              has_function_privilege('contapp_platform', p.oid, 'EXECUTE') as platform,
              has_function_privilege('contapp_app', p.oid, 'EXECUTE') as app,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) as publico
         from pg_proc p where p.pronamespace = to_regnamespace('auth') and p.proname = any($1::text[]) order by 1`,
      [[...FUNCIONES_AUTH_CUENTA]],
    );

  it("existen las 12, una firma cada una", async () => {
    const r = await catalogo();
    expect(r.map((x) => x.proname)).toEqual([...FUNCIONES_AUTH_CUENTA].sort());
  });

  it("SECURITY DEFINER, dueño contapp_auth y search_path = pg_catalog, pg_temp", async () => {
    for (const f of await catalogo()) {
      expect(f.prosecdef, `${f.proname} definer`).toBe(true);
      expect(f.dueno, `${f.proname} dueno`).toBe("contapp_auth");
      expect(f.config, `${f.proname} search_path`).toEqual(["search_path=pg_catalog, pg_temp"]);
    }
  });

  it("EXECUTE solo para contapp_backend (totp_restablecer: solo contapp_migrator); nada para PUBLIC, worker, platform ni contapp_app", async () => {
    const r = await catalogo();
    expect(r).toHaveLength(FUNCIONES_AUTH_CUENTA.length);
    for (const f of r) {
      const soloMigrator = (FUNCIONES_AUTH_SOLO_MIGRATOR as readonly string[]).includes(f.proname);
      expect(f.backend, `${f.proname} backend`).toBe(!soloMigrator);
      if (soloMigrator) expect(f.migrator, `${f.proname} migrator`).toBe(true);
      expect(f.worker, `${f.proname} worker`).toBe(false);
      expect(f.platform, `${f.proname} platform`).toBe(false);
      expect(f.app, `${f.proname} contapp_app`).toBe(false);
      expect(f.publico, `${f.proname} PUBLIC`).toBe(false);
    }
  });

  it("login_exito, sesion_validar y sesion_consultar siguen siendo una sola firma y la de login_exito tiene los 3 parametros nuevos al final", async () => {
    const r = await q(
      `select p.proname, count(*)::int as n, max(pg_get_function_identity_arguments(p.oid)) as args
         from pg_proc p where p.pronamespace = to_regnamespace('auth') and p.proname in ('login_exito', 'sesion_validar', 'sesion_consultar')
        group by p.proname order by 1`,
    );
    expect(r.map((x) => [x.proname, x.n])).toEqual([
      ["login_exito", 1],
      ["sesion_consultar", 1],
      ["sesion_validar", 1],
    ]);
    const le = r.find((x) => x.proname === "login_exito")!.args as string;
    expect(le).toMatch(/p_factor text DEFAULT|p_factor text/);
    expect(le).toMatch(/p_dispositivo text/);
    expect(le).toMatch(/p_ip_red cidr/);
    expect(le.indexOf("p_token_anterior_hash")).toBeLessThan(le.indexOf("p_factor"));
  });
});

// Spec 017 (T2, rojo): tabla `auditoria` y vecinas. Catalogo de 002 (RLS forzada en las tres tablas nuevas), CA-3 (solo agregado,
// RF-152), CHECKs de D-1, `auditoria_registrar` sin EXECUTE para la app, `auditoria_descifrado_listar` y CA-7 en SQL (dos estudios).
// Fallan por tabla o funcion ausente (0041 aun no existe).
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ACCIONES_CATALOGO,
  EscenarioAuditoria,
  ROLES_017,
  TABLAS_017,
  abrirAdmin,
  enRevertida,
  uuidAjeno,
} from "./auditoria-soporte";
import { abrirPool, filasRaw, intentarRaw } from "./soporte";

let admin: Pool;
let app: Pool;
let ec: EscenarioAuditoria;
let X: string;
let Y: string;
let ux: string;
let fx: string; // id de una fila de auditoria de X

beforeAll(async () => {
  admin = abrirAdmin(6);
  app = abrirPool(4);
  ec = new EscenarioAuditoria(admin);
  X = (await ec.estudio()).id;
  Y = (await ec.estudio()).id;
  ux = await ec.usuarioDe(X);
  await ec.cliente(X);
  await ec.cliente(Y);
  // Sin la tabla (rojo) cada prueba debe fallar por su propia razon, no toda la suite por este beforeAll.
  fx = (await ec.filas(X).catch(() => []))[0]?.id ?? uuidAjeno();
});
afterAll(async () => {
  await ec?.limpiar();
  await ec?.cerrar();
  await admin?.end();
  await app?.end();
});

const adm = async (sql: string, v: unknown[] = []) => (await admin.query(sql, v)).rows;

// =================================================================================================
describe("catalogo de 002: auditoria, notificacion y plan_aviso (D-13)", () => {
  it.each(TABLAS_017)("%s existe con tenant_id uuid NOT NULL, FK a tenant, dueño contapp_migrator, RLS ENABLE y FORCE", async (t) => {
    const c = await adm(
      `select c.relrowsecurity as rls, c.relforcerowsecurity as forzada, o.rolname as dueno,
              a.attnotnull as no_nula, ty.typname as tipo
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
         join pg_roles o on o.oid = c.relowner
         join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
         join pg_type ty on ty.oid = a.atttypid
        where c.relname = $1 and c.relkind in ('r', 'p')`,
      [t],
    );
    expect(c, `tabla ${t}`).toEqual([{ rls: true, forzada: true, dueno: "contapp_migrator", no_nula: true, tipo: "uuid" }]);
    const fk = await adm(
      `select 1 from pg_constraint where conrelid = $1::regclass and contype = 'f' and confrelid = 'public.tenant'::regclass`,
      [`public.${t}`],
    );
    expect(fk.length, `FK de ${t} a tenant`).toBeGreaterThanOrEqual(1);
  });

  it("auditoria tiene una sola politica, FOR SELECT, por app.tenant_id; ninguna FOR ALL/INSERT/UPDATE/DELETE", async () => {
    const pols = await adm(
      `select policyname, cmd, qual, with_check from pg_policies where schemaname = 'public' and tablename = 'auditoria'`,
    );
    expect(pols).toHaveLength(1);
    expect(pols[0]).toMatchObject({ cmd: "SELECT", with_check: null });
    expect(pols[0].qual).toContain("app.tenant_id");
  });

  it("notificacion tiene politicas SELECT y UPDATE (por tenant y usuario), ninguna FOR ALL, INSERT ni DELETE", async () => {
    const pols = await adm(`select cmd, qual from pg_policies where schemaname = 'public' and tablename = 'notificacion'`);
    expect(pols.map((p) => p.cmd).sort()).toEqual(["SELECT", "UPDATE"]);
    for (const p of pols) {
      expect(p.qual).toContain("app.tenant_id");
      expect(p.qual).toContain("app.user_id");
    }
  });

  it("auditoria tiene PK uuid v7, los indices (tenant, ocurrida_en desc) y (tenant, cliente, ocurrida_en desc) y los CHECK de D-1", async () => {
    const d = await adm(
      `select column_default from information_schema.columns where table_schema = 'public' and table_name = 'auditoria' and column_name = 'id'`,
    );
    expect(d[0]?.column_default).toContain("uuid_v7");
    const idx = (await adm(`select indexdef from pg_indexes where schemaname = 'public' and tablename = 'auditoria'`)).map(
      (x) => x.indexdef as string,
    );
    expect(idx.some((i) => /\(tenant_id, ocurrida_en DESC/.test(i)), "indice por fecha").toBe(true);
    expect(idx.some((i) => /\(tenant_id, cliente_id, ocurrida_en DESC/.test(i)), "indice por cliente").toBe(true);
    const cols = (
      await adm(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'auditoria'`)
    ).map((x) => x.column_name as string);
    for (const c of [
      "tenant_id", "ocurrida_en", "actor_tipo", "usuario_id", "trabajo_id", "accion", "cliente_id", "entidad", "entidad_id", "datos",
    ]) {
      expect(cols, c).toContain(c);
    }
  });
});

// =================================================================================================
describe("CHECKs de auditoria (D-1) y ausencia de FK a usuario, cliente y trabajo", () => {
  const INSERT = `insert into auditoria (tenant_id, actor_tipo, usuario_id, trabajo_id, accion, cliente_id, entidad, entidad_id, datos)
    values ($1, $2, $3, $4, $5, $6, 'cliente', $7, $8::jsonb)`;
  const probar = (a: Partial<Record<"actor" | "usuario" | "trabajo" | "accion" | "datos", unknown>>) =>
    enRevertida(admin, async (c) => {
      await c.query(INSERT, [
        X,
        a.actor ?? "usuario",
        a.usuario === undefined ? uuidAjeno() : a.usuario,
        a.trabajo === undefined ? null : a.trabajo,
        a.accion ?? "cliente.creado",
        uuidAjeno(),
        uuidAjeno(),
        a.datos ?? "{}",
      ]);
    });

  it("control positivo: un usuario, un trabajo y el sistema se aceptan aunque usuario, cliente y trabajo no existan (sin FK)", async () => {
    expect(await probar({})).toEqual({ ok: true });
    expect(await probar({ actor: "trabajo", usuario: null, trabajo: uuidAjeno() })).toEqual({ ok: true });
    expect(await probar({ actor: "trabajo", usuario: uuidAjeno(), trabajo: uuidAjeno() })).toEqual({ ok: true });
    expect(await probar({ actor: "sistema", usuario: null })).toEqual({ ok: true });
  });

  it.each([
    ["usuario sin usuario_id", { actor: "usuario", usuario: null }],
    ["usuario con trabajo_id", { actor: "usuario", trabajo: uuidAjeno() }],
    ["trabajo sin trabajo_id", { actor: "trabajo", usuario: null, trabajo: null }],
    ["sistema con usuario_id", { actor: "sistema", usuario: uuidAjeno() }],
    ["sistema con trabajo_id", { actor: "sistema", usuario: null, trabajo: uuidAjeno() }],
    ["actor_tipo fuera de catalogo", { actor: "admin", usuario: null }],
  ])("rechaza (23514) actor incoherente: %s", async (_n, a) => {
    const r = await probar(a);
    expect(r.ok ? "ok" : r.code).toBe("23514");
  });

  it("rechaza (23514) una accion fuera del catalogo cerrado y acepta las 27 del catalogo (D-3 + credencial.descifrada + sunat.envio)", async () => {
    for (const mala of ["cliente.borrado", "Cliente.creado", "x", ""]) {
      const r = await probar({ accion: mala });
      expect(r.ok ? "ok" : r.code, mala).toBe("23514");
    }
    expect(ACCIONES_CATALOGO).toHaveLength(27);
    for (const accion of ACCIONES_CATALOGO) expect(await probar({ accion }), accion).toEqual({ ok: true });
  });

  it("rechaza (23514) `datos` que no es un objeto o pesa mas de 4096 bytes; acepta el limite", async () => {
    for (const mal of ["[]", '"texto"', "1", "null"]) {
      const r = await probar({ datos: mal });
      expect(r.ok ? "ok" : r.code, mal).toBe("23514");
    }
    const grande = JSON.stringify({ x: "a".repeat(5000) });
    const r = await probar({ datos: grande });
    expect(r.ok ? "ok" : r.code).toBe("23514");
    expect(await probar({ datos: JSON.stringify({ x: "a".repeat(3000) }) })).toEqual({ ok: true });
  });

  it("un INSERT con un tenant_id inexistente falla por la FK (23503)", async () => {
    const r = await enRevertida(admin, async (c) => {
      await c.query(INSERT, [uuidAjeno(), "sistema", null, null, "cliente.creado", null, uuidAjeno(), "{}"]);
    });
    expect(r.ok ? "ok" : r.code).toBe("23503");
  });
});

// =================================================================================================
describe("CA-3 · solo agregado (RF-152, D-2)", () => {
  const ESCRITURAS = ["INSERT", "UPDATE", "DELETE", "TRUNCATE"] as const;

  it.each(ROLES_017)("%s no tiene INSERT, UPDATE, DELETE ni TRUNCATE (ni REFERENCES, TRIGGER, ni por columna) sobre auditoria", async (rol) => {
    for (const p of [...ESCRITURAS, "REFERENCES", "TRIGGER"]) {
      const v = (await adm("select has_table_privilege($1, 'public.auditoria', $2) as v", [rol, p]))[0].v;
      expect(v, `${rol} ${p}`).toBe(false);
    }
    for (const p of ["INSERT", "UPDATE", "REFERENCES"]) {
      const v = (await adm("select has_any_column_privilege($1, 'public.auditoria', $2) as v", [rol, p]))[0].v;
      expect(v, `${rol} ${p} (columna)`).toBe(false);
    }
  });

  it("solo contapp_backend lee auditoria (SELECT); el worker, contapp_app y contapp_platform no", async () => {
    const sel = async (rol: string) =>
      (await adm("select has_table_privilege($1, 'public.auditoria', 'SELECT') as v", [rol]))[0].v as boolean;
    expect(await sel("contapp_backend")).toBe(true);
    for (const rol of ["contapp_worker", "contapp_app", "contapp_platform"]) expect(await sel(rol), rol).toBe(false);
  });

  it("plan_aviso no da ningun privilegio a los roles de la app y notificacion no da INSERT, DELETE ni TRUNCATE a ninguno", async () => {
    for (const rol of ROLES_017) {
      for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
        const v = (await adm("select has_table_privilege($1, 'public.plan_aviso', $2) as v", [rol, p]))[0].v;
        expect(v, `plan_aviso ${rol} ${p}`).toBe(false);
      }
      for (const p of ["INSERT", "DELETE", "TRUNCATE"]) {
        const v = (await adm("select has_table_privilege($1, 'public.notificacion', $2) as v", [rol, p]))[0].v;
        expect(v, `notificacion ${rol} ${p}`).toBe(false);
      }
    }
  });

  it.each(["contapp_backend", "contapp_worker"])(
    "como %s, con contexto de estudio: INSERT, UPDATE, DELETE y TRUNCATE sobre auditoria dan 42501 (permission denied)",
    async (rol) => {
      for (const sql of [
        `insert into auditoria (tenant_id, actor_tipo, accion, entidad, entidad_id, datos)
         values ('${X}', 'sistema', 'cliente.creado', 'cliente', '${uuidAjeno()}', '{}')`,
        `update auditoria set datos = '{}'::jsonb`,
        `delete from auditoria`,
        `truncate auditoria`,
      ]) {
        const c = await app.connect();
        try {
          await c.query("BEGIN");
          await c.query(`SET LOCAL ROLE ${rol}`);
          await c.query("select set_config('app.tenant_id', $1, true)", [X]);
          let code = "ok";
          let message = "";
          try {
            await c.query(sql);
          } catch (e) {
            code = String((e as { code?: string }).code);
            message = String((e as Error).message);
          }
          expect(code, `${rol}: ${sql.slice(0, 30)}`).toBe("42501");
          expect(message).toMatch(/permission denied/i);
        } finally {
          await c.query("ROLLBACK").catch(() => undefined);
          c.release();
        }
      }
    },
  );

  it("el dueño (contapp_migrator) y el superusuario: UPDATE, DELETE y TRUNCATE los rechaza el trigger (42501); la fila queda", async () => {
    for (const rol of [null, "contapp_migrator"]) {
      for (const sql of [
        `update auditoria set datos = '{"x":1}'::jsonb where id = '${fx}'`,
        `update auditoria set tenant_id = tenant_id where id = '${fx}'`,
        `delete from auditoria where id = '${fx}'`,
        `delete from auditoria where tenant_id = '${X}'`,
        `truncate auditoria`,
      ]) {
        const r = await enRevertida(admin, async (c) => {
          if (rol) await c.query(`SET LOCAL ROLE ${rol}`);
          await c.query(sql);
        });
        expect(r.ok ? "ok" : r.code, `${rol ?? "superusuario"}: ${sql.slice(0, 40)}`).toBe("42501");
      }
    }
    expect((await adm("select count(*)::int as n from auditoria where id = $1", [fx]))[0].n).toBe(1);
  });

  it("solo session_replication_role = replica salta el trigger (la limpieza de las pruebas); un UPDATE sin esa marca falla", async () => {
    const r = await enRevertida(admin, async (c) => {
      await c.query("SET LOCAL session_replication_role = replica");
      const d = await c.query("delete from auditoria where id = $1", [fx]);
      expect(d.rowCount).toBe(1);
    });
    expect(r).toEqual({ ok: true });
    const sin = await enRevertida(admin, async (c) => {
      await c.query("delete from auditoria where id = $1", [fx]);
    });
    expect(sin.ok ? "ok" : sin.code).toBe("42501");
  });

  it("los triggers de inmutabilidad existen por fila (UPDATE/DELETE) y por sentencia (TRUNCATE)", async () => {
    const t = await adm(
      `select tgname, tgtype from pg_trigger where tgrelid = 'public.auditoria'::regclass and not tgisinternal order by tgname`,
    );
    const porFila = t.filter((x) => (Number(x.tgtype) & 1) === 1 && (Number(x.tgtype) & 2) === 2); // ROW + BEFORE
    const truncate = t.filter((x) => (Number(x.tgtype) & 32) === 32); // TRUNCATE
    expect(porFila.length, "BEFORE UPDATE OR DELETE por fila").toBeGreaterThanOrEqual(1);
    expect(truncate.length, "BEFORE TRUNCATE por sentencia").toBeGreaterThanOrEqual(1);
  });
});

// =================================================================================================
describe("funciones de 0041: auditoria_registrar y auditoria_descifrado_listar", () => {
  const funcion = async (nombre: string) =>
    adm(
      `select p.oid::regprocedure::text as firma, p.oid as oid, p.prosecdef as secdef, pg_get_userbyid(p.proowner) as dueno,
              p.proconfig as config
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public' where p.proname = $1`,
      [nombre],
    );

  it("auditoria_registrar: SECURITY DEFINER de contapp_migrator con search_path fijo y SIN EXECUTE para PUBLIC ni los roles de la app", async () => {
    const f = await funcion("auditoria_registrar");
    expect(f.length, "auditoria_registrar existe").toBe(1);
    expect(f[0]).toMatchObject({ secdef: true, dueno: "contapp_migrator" });
    expect((f[0].config as string[]).join(" ")).toMatch(/search_path=pg_catalog, pg_temp/);
    for (const rol of ROLES_017) {
      const v = (await adm("select has_function_privilege($1, $2::oid, 'EXECUTE') as v", [rol, f[0].oid]))[0].v;
      expect(v, rol).toBe(false);
    }
    const publico = (await adm("select has_function_privilege('public', $1::oid, 'EXECUTE') as v", [f[0].oid]))[0].v;
    expect(publico, "PUBLIC").toBe(false);
  });

  it("auditoria_registrar: contapp_auth si puede ejecutarla (las funciones auth.* la usan)", async () => {
    const f = await funcion("auditoria_registrar");
    expect(f.length).toBe(1);
    const v = (await adm("select has_function_privilege('contapp_auth', $1::oid, 'EXECUTE') as v", [f[0].oid]))[0].v;
    expect(v).toBe(true);
  });

  it.each(["contapp_backend", "contapp_worker"])("%s no puede llamar a auditoria_registrar para falsificar una fila (42501)", async (rol) => {
    const r = await intentarRaw(
      app,
      rol,
      `select auditoria_registrar($1::uuid, 'cliente.creado', null::uuid, 'cliente', $2::uuid, '{}'::jsonb, $3::uuid)`,
      [X, uuidAjeno(), uuidAjeno()],
    );
    expect(r.ok ? "ok" : r.code).toBe("42501");
  });

  it("auditoria_registrar lanza si app.tenant_id esta fijado y difiere del tenant pedido (no cruza estudios)", async () => {
    const r = await enRevertida(admin, async (c) => {
      await c.query("select set_config('app.tenant_id', $1, true)", [X]);
      await c.query(
        `select auditoria_registrar($1::uuid, 'cliente.creado', null::uuid, 'cliente', $2::uuid, '{}'::jsonb, null::uuid)`,
        [Y, uuidAjeno()],
      );
    });
    expect(r.ok).toBe(false);
    // Lanza por la regla del tenant, no porque la funcion falte (42883) ni la tabla (42P01).
    if (!r.ok) expect(["42883", "42P01"]).not.toContain(r.code);
  });

  it("auditoria_registrar escribe UNA fila con el tenant pedido cuando coincide con el contexto", async () => {
    const id = uuidAjeno();
    const r = await enRevertida(admin, async (c) => {
      await c.query("select set_config('app.tenant_id', $1, true)", [X]);
      await c.query(
        `select auditoria_registrar($1::uuid, 'cliente.creado', null::uuid, 'cliente', $2::uuid, '{"origen":"manual"}'::jsonb, null::uuid)`,
        [X, id],
      );
      const n = await c.query("select count(*)::int as n, min(actor_tipo) as a from auditoria where entidad_id = $1", [id]);
      expect(n.rows[0]).toEqual({ n: 1, a: "sistema" });
    });
    expect(r).toEqual({ ok: true });
  });

  it("auditoria_descifrado_listar: SECURITY DEFINER con search_path fijo, EXECUTE solo para contapp_backend", async () => {
    const f = await funcion("auditoria_descifrado_listar");
    expect(f.length, "auditoria_descifrado_listar existe").toBe(1);
    expect(f[0]).toMatchObject({ secdef: true, dueno: "contapp_migrator" });
    expect((f[0].config as string[]).join(" ")).toMatch(/search_path=pg_catalog, pg_temp/);
    const quien: Record<string, boolean> = {};
    for (const rol of ROLES_017) {
      quien[rol] = (await adm("select has_function_privilege($1, $2::oid, 'EXECUTE') as v", [rol, f[0].oid]))[0].v;
    }
    expect(quien).toEqual({ contapp_backend: true, contapp_worker: false, contapp_app: false, contapp_platform: false });
    const publico = (await adm("select has_function_privilege('public', $1::oid, 'EXECUTE') as v", [f[0].oid]))[0].v;
    expect(publico, "PUBLIC").toBe(false);
  });

  it("003 no cambia: la app sigue sin SELECT sobre auditoria_descifrado (la consulta pasa por la funcion)", async () => {
    for (const rol of ["contapp_backend", "contapp_worker"]) {
      const v = (await adm("select has_table_privilege($1, 'public.auditoria_descifrado', 'SELECT') as v", [rol]))[0].v;
      expect(v, rol).toBe(false);
    }
  });
});

// =================================================================================================
describe("CA-7 en SQL · aislamiento entre estudios", () => {
  const ctx = (tenant: string) => ({ tenantId: tenant });

  it("con la sesion de X, auditoria devuelve solo filas de X: las de Y no aparecen ni por tenant_id ni por id", async () => {
    const propias = (await ec.filas(X)).map((f) => f.id);
    const ajenas = (await ec.filas(Y)).map((f) => f.id);
    expect(propias.length).toBeGreaterThan(0);
    expect(ajenas.length).toBeGreaterThan(0);
    const vistas = await ec.backend.withTenant(ctx(X), async (tx) => (await tx.query("select id, tenant_id from auditoria")).rows);
    expect(vistas.every((f: { tenant_id: string }) => f.tenant_id === X)).toBe(true);
    expect(vistas.map((f: { id: string }) => f.id).sort()).toEqual(propias.sort());
    const porTenant = await ec.backend.withTenant(ctx(X), async (tx) =>
      (await tx.query("select id from auditoria where tenant_id = $1", [Y])).rows,
    );
    const porId = await ec.backend.withTenant(ctx(X), async (tx) =>
      (await tx.query("select id from auditoria where id = any($1::uuid[])", [ajenas])).rows,
    );
    expect(porTenant).toEqual([]);
    expect(porId).toEqual([]);
  });

  it("sin tenant fijado, o con tenant vacio, auditoria devuelve 0 filas (falla cerrado)", async () => {
    expect(await filasRaw(app, "contapp_backend", "select * from auditoria")).toEqual([]);
    const c = await app.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE contapp_backend");
      await c.query("select set_config('app.tenant_id', '', true)");
      expect((await c.query("select * from auditoria")).rows).toEqual([]);
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  });

  it("contapp_app (rol de login sin SET ROLE) no lee auditoria (42501)", async () => {
    const r = await intentarRaw(app, null, "select * from auditoria");
    expect(r.ok ? "ok" : r.code).toBe("42501");
  });

  it("el usuario del estudio X (userId) no ve la auditoria de Y tampoco al fijar su userId", async () => {
    const vistas = await ec.backend.withTenant({ tenantId: X, userId: ux }, async (tx) => (await tx.query("select tenant_id from auditoria")).rows);
    expect(vistas.length).toBeGreaterThan(0);
    expect(vistas.every((f: { tenant_id: string }) => f.tenant_id === X)).toBe(true);
  });
});

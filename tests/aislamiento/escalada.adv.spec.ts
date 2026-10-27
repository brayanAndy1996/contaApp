// Ronda adversarial 1 (T8, spec 002): escalada de privilegios desde la conexion de DATABASE_URL
// (rol de login y roles de la app), DDL contra RLS, GUC peligrosos y SECURITY DEFINER.
// Solo DATABASE_URL. Todo se ejecuta en transacciones que se revierten.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  abrirPool,
  crearDb,
  enRollback,
  filasRaw,
  intentar,
  intentarRaw,
  semilla,
  tenantDe,
  type ContappDb,
  type Intento,
  type Tx,
} from "./soporte";
import type { Pool } from "pg";
import { FUNCIONES_AUTH } from "./auth-soporte";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Ejecuta el CLI `migrar` ya compilado (como `pnpm db:migrate`); devuelve stdout+stderr. */
function correrMigrar(): Promise<string> {
  const script = fileURLToPath(
    new URL("../../packages/db/dist/cli/migrar.js", import.meta.url),
  );
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [script],
      { env: process.env, timeout: 50_000 },
      (err, stdout, stderr) => {
        const salida = `${stdout}${stderr}`;
        if (err) reject(new Error(`migrar fallo (codigo ${String(err.code)})`));
        else resolve(salida);
      },
    );
  });
}

async function capturar(
  tx: Tx,
  text: string,
  values: unknown[] = [],
): Promise<Intento> {
  try {
    const r = await tx.query(text, values);
    return { ok: true, rowCount: r.rowCount ?? 0 };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return {
      ok: false,
      code: String(err.code ?? ""),
      message: String(err.message ?? ""),
    };
  }
}

describe("ADV escalada desde DATABASE_URL", () => {
  let pool: Pool;
  let backend: ContappDb;
  let worker: ContappDb;
  let superusuario: string;
  beforeAll(async () => {
    pool = abrirPool(2);
    backend = crearDb("contapp_backend");
    worker = crearDb("contapp_worker");
    const r = await pool.query(
      `select rolname from pg_roles where rolsuper order by oid limit 1`,
    );
    superusuario = r.rows[0].rolname as string;
  });
  afterAll(async () => {
    await backend?.close();
    await worker?.close();
    await pool?.end();
  });
  const ctxA = () => ({ tenantId: tenantDe("A") });

  it("desde un rol de app (dentro de withTenant) no se llega a migrator ni al superusuario; RESET ROLE no da acceso", async () => {
    const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const intentos = [
      await intentar(backend, ctxA(), `set role contapp_migrator`),
      await intentar(backend, ctxA(), `set role ${ident(superusuario)}`),
      await intentar(
        backend,
        ctxA(),
        `set session authorization ${ident(superusuario)}`,
      ),
      await intentar(
        backend,
        ctxA(),
        `set session authorization contapp_migrator`,
      ),
    ];
    for (const r of intentos) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("42501");
    }
    const tras = await enRollback(backend, ctxA(), async (tx) => {
      await tx.query(`reset role`);
      return {
        quien: (await tx.query(`select current_user as u`)).rows[0].u as string,
        lectura: await capturar(tx, `select id from cliente`),
      };
    });
    expect(tras.quien).toBe("contapp_app");
    expect(tras.lectura.ok).toBe(false);
  });

  it("desde un rol de app no se puede cambiar a otro rol (platform/backend) para ganar privilegios ajenos", async () => {
    // backend -> platform: escribir usuarios de cualquier estudio (p. ej. cambiar el email de uB).
    const aPlatform = await enRollback(backend, ctxA(), async (tx) => {
      const set = await capturar(tx, `set local role contapp_platform`);
      const escritura = set.ok
        ? await capturar(
            tx,
            `update usuario set nombre = nombre where id = $1`,
            [semilla().uB],
          )
        : set;
      return { set, escritura };
    });
    // worker -> backend: leer usuario, que worker no tiene concedido.
    const aBackend = await enRollback(worker, ctxA(), async (tx) => {
      const set = await capturar(tx, `set local role contapp_backend`);
      const lectura = set.ok
        ? await capturar(tx, `select id from usuario`)
        : set;
      return { set, lectura };
    });
    // D8: contapp_platform queda fuera del alcance del login de la app.
    expect(aPlatform.set.ok).toBe(false);
    if (!aPlatform.set.ok) expect(aPlatform.set.code).toBe("42501");
    expect(aPlatform.escritura.ok).toBe(false);
    // RIESGO ACEPTADO (D8): el worker puede pasar a contapp_backend (y leer usuario con su RLS).
    // Se fija el comportamiento conocido; si cambia, la prueba falla y obliga a revisar D8.
    expect(aBackend.set).toEqual({ ok: true, rowCount: 0 });
    expect(aBackend.lectura.ok).toBe(true);
  });

  it("ningun rol de la conexion puede desactivar RLS, tocar politicas ni crear objetos que la esquiven", async () => {
    const ddl = [
      `alter table cliente disable row level security`,
      `alter table cliente no force row level security`,
      `alter policy tenant_isolation on cliente using (true)`,
      `drop policy tenant_isolation on cliente`,
      `create policy abierta on cliente for select using (true)`,
      `alter table cliente owner to contapp_backend`,
      // GRANT sin privilegio de concesion no falla (solo WARNING "no privileges were granted"):
      // solo cuenta como exito si el privilegio quedo realmente concedido.
      `do $$ begin execute 'grant select on cliente to contapp_app';
         if not has_table_privilege('contapp_app', 'public.cliente', 'select') then raise exception 'sin efecto'; end if;
         end $$`,
      `create function public.f_adv() returns setof cliente language sql security definer as 'select * from cliente'`,
      `create view public.v_adv as select * from cliente`,
      `create temp table t_adv (x int)`,
      `create schema s_adv`,
      `create extension if not exists dblink`,
    ];
    // D8: contapp_platform ya no es alcanzable desde el login (se comprueba aparte), asi que el
    // DDL se intenta solo con los roles a los que la conexion de DATABASE_URL si puede pasar.
    const roles = [null, "contapp_backend", "contapp_worker"];
    const exitos: string[] = [];
    for (const rol of roles) {
      for (const sql of ddl) {
        const r = await intentarRaw(pool, rol, sql);
        if (r.ok) exitos.push(`${rol ?? "contapp_app"}: ${sql}`);
      }
    }
    expect(exitos).toEqual([]);
    const aPlatform = await intentarRaw(
      pool,
      null,
      `set local role contapp_platform`,
    );
    expect(aPlatform.ok).toBe(false);
    if (!aPlatform.ok) expect(aPlatform.code).toBe("42501");
  });

  it("row_security = off falla cerrado y session_replication_role (salta FK/triggers) es rechazado", async () => {
    const rs = await enRollback(backend, ctxA(), async (tx) => {
      await tx.query(`set local row_security = off`);
      return capturar(tx, `select id from cliente`);
    });
    expect(rs.ok).toBe(false);
    if (!rs.ok) expect(rs.code).toBe("42501");
    const srr = await intentar(
      backend,
      ctxA(),
      `set local session_replication_role = replica`,
    );
    expect(srr.ok).toBe(false);
  });

  // H7, D10 (opcion A): limite conocido de PostgreSQL 17 (todo rol LOGIN puede fijar sus propios
  // valores por defecto de sesion con ALTER ROLE self [IN DATABASE d] SET). No se exige que el ataque
  // falle: se comprueba que `migrar` (el CLI real, unico lector de MIGRATIONS_DATABASE_URL, CA-2b)
  // restaura la configuracion de contapp_app. El ataque se persiste con valores que solo afectan a
  // conexiones nuevas y `migrar` se ejecuta siempre (finally) para limpiarlo. La contrasena
  // (PASSWORD NULL) no se ataca aqui: dejaria sin login a la suite si la reparacion fallara.
  it("H7 (D10): tras persistir valores por defecto de sesion en contapp_app, migrar los restaura", async () => {
    const leerAjustes = `select s.setdatabase::int as setdatabase, s.setconfig
        from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
       where r.rolname = 'contapp_app' order by 1`;
    const esperado = [{ setdatabase: 0, setconfig: ["lc_messages=C"] }];
    const sondear = async (sql: string): Promise<true | string> => {
      try {
        await pool.query(sql);
        return true;
      } catch (e) {
        return String((e as { code?: string }).code ?? "");
      }
    };
    let antes: unknown[] = [];
    const resultados: (true | string)[] = [];
    let salida = "";
    try {
      // Nombre de la base citado en el servidor (%I), no interpolado en el cliente.
      const enBase = (
        await pool.query(
          `select format('alter role contapp_app in database %I set work_mem = %L', current_database(), '64kB') as s`,
        )
      ).rows[0].s as string;
      resultados.push(
        await sondear(`alter role contapp_app set app.tenant_id = '${tenantDe("B")}'`),
        await sondear(`alter role contapp_app set row_security = off`),
        await sondear(enBase),
      );
      antes = await filasRaw(pool, null, leerAjustes);
    } finally {
      salida = await correrMigrar();
    }
    // Comportamiento conocido: PG rechaza el GUC propio app.tenant_id (placeholder sin privilegio
    // SET), pero acepta los parametros USERSET, tambien IN DATABASE (limite de PG). Si cambia, revisar D10.
    expect(resultados).toEqual(["42501", true, true]);
    expect(JSON.stringify(antes)).toContain("row_security=off");
    expect(JSON.stringify(antes)).toContain("work_mem=64kB");
    // migrar repara y solo informa estados fijos, sin secretos.
    expect(salida).toContain("migrar: ajustes de contapp_app reparados");
    expect(salida).toContain("migrar: OK");
    const pw = decodeURIComponent(new URL(String(process.env.DATABASE_URL)).password);
    expect(pw.length > 0 && salida.includes(pw)).toBe(false);
    // Estado restaurado: solo el ajuste esperado y una conexion nueva arranca sin los valores del ataque.
    expect(await filasRaw(pool, null, leerAjustes)).toEqual(esperado);
    const nuevo = abrirPool(1);
    try {
      const r = await nuevo.query(
        `select current_setting('row_security') as rs, current_setting('work_mem') as wm`,
      );
      expect(r.rows[0].rs).toBe("on");
      expect(r.rows[0].wm).not.toBe("64kB");
    } finally {
      await nuevo.end();
    }
  }, 60_000);

  it("no existen funciones SECURITY DEFINER ni vistas sin security_invoker fuera de los esquemas del sistema", async () => {
    const defs = await filasRaw(
      pool,
      null,
      `select n.nspname || '.' || p.proname as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.prosecdef and n.nspname not in ('pg_catalog', 'information_schema')`,
    );
    const vistas = await filasRaw(
      pool,
      null,
      `select n.nspname || '.' || c.relname as v from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('v', 'm') and n.nspname not in ('pg_catalog', 'information_schema')
          and not coalesce('security_invoker=true' = any(c.reloptions), false)`,
    );
    const uuid = await filasRaw(
      pool,
      null,
      `select p.prosecdef, pg_get_userbyid(p.proowner) as dueno from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'uuid_v7'`,
    );
    // Spec 004 (D10) y 005 (D7): las unicas SECURITY DEFINER admitidas son las de FUNCIONES_AUTH (15) del esquema `auth`.
    expect(defs.map((d) => d.f).sort()).toEqual(FUNCIONES_AUTH.map((n) => `auth.${n}`).sort());
    expect(vistas).toEqual([]);
    expect(uuid).toEqual([{ prosecdef: false, dueno: "contapp_migrator" }]);
  });
});

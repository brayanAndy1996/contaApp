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
    expect(aPlatform.set.ok).toBe(false);
    expect(aPlatform.escritura.ok).toBe(false);
    expect(aBackend.set.ok).toBe(false);
    expect(aBackend.lectura.ok).toBe(false);
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
    const roles = [
      null,
      "contapp_backend",
      "contapp_worker",
      "contapp_platform",
    ];
    const exitos: string[] = [];
    for (const rol of roles) {
      for (const sql of ddl) {
        const r = await intentarRaw(pool, rol, sql);
        if (r.ok) exitos.push(`${rol ?? "contapp_app"}: ${sql}`);
      }
    }
    expect(exitos).toEqual([]);
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

  it("el rol de login no puede fijar valores por defecto de sesion para si mismo (app.tenant_id, role) ni su contraseña", async () => {
    const tenantB = tenantDe("B");
    const intentos = [
      await intentarRaw(
        pool,
        null,
        `alter role contapp_app set app.tenant_id = '${tenantB}'`,
      ),
      await intentarRaw(
        pool,
        null,
        `alter role contapp_app set role = 'contapp_platform'`,
      ),
      await intentarRaw(
        pool,
        null,
        `alter role contapp_app set row_security = off`,
      ),
      await intentarRaw(pool, null, `alter role contapp_app password null`),
    ];
    // Todo se revirtio (ROLLBACK): ningun ajuste quedo persistido.
    const persistido = await filasRaw(
      pool,
      null,
      `select s.setconfig from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
        where r.rolname = 'contapp_app'`,
    );
    expect(JSON.stringify(persistido)).not.toContain("app.tenant_id");
    expect(intentos.map((r) => r.ok)).toEqual([false, false, false, false]);
  });

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
    expect(defs).toEqual([]);
    expect(vistas).toEqual([]);
    expect(uuid).toEqual([{ prosecdef: false, dueno: "contapp_migrator" }]);
  });
});

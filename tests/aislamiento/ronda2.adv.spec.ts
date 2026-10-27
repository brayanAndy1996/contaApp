// Ronda adversarial 2 (T10 parte b, spec 002): fugas entre estudios en lo agregado por T9.
// - Politicas de solo lectura de `tenant` y `usuario` (0003): JOIN, subconsultas, catalogo
//   (pg_stats), funciones que ejecutan SQL (query_to_xml), cursores WITH HOLD y EXPLAIN ANALYZE,
//   con withTenant y withUsuario.
// - Limpieza de la conexion del pool (LIMPIAR_SESION): sentencias preparadas, LISTEN, advisory
//   locks, GUC de aplicacion, transaccion abierta heredada, objetos grandes (fuera de RLS).
// - `reparar-rol.ts` + idempotencia de `migrar` (se ejecuta el CLI, que lee su propia URL).
// Solo DATABASE_URL. Cada prueba afirma el comportamiento seguro esperado.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  abrirPool,
  clientesDe,
  crearDb,
  semilla,
  tenantDe,
  type ContappDb,
  type Estudio,
  type Intento,
  type Tx,
} from "./soporte";

async function capturar(tx: Tx, text: string, values: unknown[] = []): Promise<Intento & { rows?: any[] }> {
  try {
    const r = await tx.query(text, values);
    return { ok: true, rowCount: r.rowCount ?? 0, rows: r.rows };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, code: String(err.code ?? ""), message: String(err.message ?? "") };
  }
}

const ordenar = (xs: string[]) => [...xs].sort();
const ids = (rows: any[]) => ordenar(rows.map((r) => String(r.id)));
const miembrosDe = (e: Estudio) => (e === "A" ? [semilla().uA, semilla().uAB] : [semilla().uB, semilla().uAB]);
const soloDe = (e: Estudio) => (e === "A" ? semilla().uA : semilla().uB);
const otroEst = (e: Estudio): Estudio => (e === "A" ? "B" : "A");

describe("ADV2 politicas de solo lectura de tenant y usuario (0003)", () => {
  let backend: ContappDb;
  let worker: ContappDb;
  beforeAll(() => {
    backend = crearDb("contapp_backend");
    worker = crearDb("contapp_worker");
  });
  afterAll(async () => {
    await backend?.close();
    await worker?.close();
  });

  it("withTenant(X) backend: tabla, JOIN, subconsulta escalar y EXISTS solo ven usuarios y estudio de X", async () => {
    for (const e of ["A", "B"] as Estudio[]) {
      const ajeno = soloDe(otroEst(e));
      const tAjeno = tenantDe(otroEst(e));
      const r = await backend.withTenant({ tenantId: tenantDe(e) }, async (tx) => ({
        usuarios: ids((await tx.query(`select id from usuario`)).rows),
        porJoin: ids(
          (await tx.query(`select u.id from cliente c join tenant t on t.id = c.tenant_id
                             join membresia m on m.tenant_id = t.id join usuario u on u.id = m.usuario_id`)).rows,
        ),
        escalar: (await tx.query(`select (select email from usuario where id = $1) as e`, [ajeno])).rows[0].e,
        existe: (await tx.query(`select exists(select 1 from usuario where id = $1) as x`, [ajeno])).rows[0].x,
        tenants: ids((await tx.query(`select id from tenant`)).rows),
        tenantAjeno: (await tx.query(`select count(*)::int as n from tenant where id = $1`, [tAjeno])).rows[0].n,
        lateral: (await tx.query(
          `select count(*)::int as n from (values ($1::uuid)) v(id) left join lateral
             (select nombre from tenant t where t.id = v.id) x on true where x.nombre is not null`,
          [tAjeno],
        )).rows[0].n,
      }));
      expect(r.usuarios).toEqual(ordenar(miembrosDe(e)));
      expect(r.porJoin.includes(ajeno)).toBe(false);
      expect(r.escalar).toBeNull();
      expect(r.existe).toBe(false);
      expect(r.tenants).toEqual([tenantDe(e)]);
      expect(r.tenantAjeno).toBe(0);
      expect(r.lateral).toBe(0);
    }
  });

  it("withUsuario: cada usuario ve solo sus estudios y solo su propia fila de usuario", async () => {
    const s = semilla();
    const casos: Array<[string, string[], string[]]> = [
      [s.uA, [s.tenantA], [s.uA]],
      [s.uB, [s.tenantB], [s.uB]],
      [s.uAB, ordenar([s.tenantA, s.tenantB]), [s.uAB]],
      ["01920000-0000-7000-8000-00000000dead", [], []],
    ];
    for (const [u, tEsp, uEsp] of casos) {
      const r = await backend.withUsuario({ userId: u }, async (tx) => ({
        t: ids((await tx.query(`select id from tenant`)).rows),
        u: ids((await tx.query(`select id from usuario`)).rows),
        uPorMembresia: ids(
          (await tx.query(`select u.id from tenant t join membresia m on m.tenant_id = t.id
                             join usuario u on u.id = m.usuario_id`)).rows,
        ),
      }));
      expect(r.t).toEqual(tEsp);
      expect(r.u).toEqual(uEsp);
      expect(r.uPorMembresia.every((x) => x === u)).toBe(true);
    }
  });

  it("worker: tenant solo del estudio actual (o de sus membresias en withUsuario) y usuario denegado", async () => {
    const s = semilla();
    const r = await worker.withTenant({ tenantId: s.tenantA }, async (tx) => ({
      t: ids((await tx.query(`select id from tenant`)).rows),
      u: await capturar(tx, `select id from usuario`),
    }));
    expect(r.t).toEqual([s.tenantA]);
    expect(r.u.ok).toBe(false);
    if (!r.u.ok) expect(r.u.code).toBe("42501");
    const w = await worker.withUsuario({ userId: s.uB }, async (tx) => ids((await tx.query(`select id from tenant`)).rows));
    expect(w).toEqual([s.tenantB]);
  });

  it("D9: withTenant(A) con un userId que no es miembro de A no ve a ese usuario (solo miembros de A)", async () => {
    const s = semilla();
    const vistos = await backend.withTenant({ tenantId: s.tenantA, userId: s.uB }, async (tx) =>
      ids((await tx.query(`select id from usuario`)).rows),
    );
    expect(vistos).toEqual(ordenar([s.uA, s.uAB]));
  });

  it("la politica se evalua antes que predicados que lanzan error (sin oraculo por division por cero)", async () => {
    for (const e of ["A", "B"] as Estudio[]) {
      const ajeno = soloDe(otroEst(e));
      const tAjeno = tenantDe(otroEst(e));
      const r = await backend.withTenant({ tenantId: tenantDe(e) }, async (tx) => ({
        u: await capturar(tx, `select id from usuario where id = $1 and 1 / (length(email) - length(email)) = 1`, [ajeno]),
        t: await capturar(tx, `select id from tenant where id = $1 and 1 / (length(nombre) - length(nombre)) = 1`, [tAjeno]),
        // Ultima: puede abortar la transaccion (error sobre filas propias).
        uLike: await capturar(tx, `select id from usuario where email like 'u%' and 1 / (length(email) - length(email)) = 1`),
      }));
      // Sobre filas propias si puede haber division por cero; sobre las ajenas nunca debe evaluarse.
      expect(r.u).toMatchObject({ ok: true, rowCount: 0 });
      expect(r.t).toMatchObject({ ok: true, rowCount: 0 });
      if (!r.uLike.ok) expect(r.uLike.code).toBe("22012"); // error solo por filas propias
    }
  });

  it("EXPLAIN ANALYZE no muestra filas reales de usuario/tenant de otro estudio", async () => {
    const s = semilla();
    const planes = await backend.withTenant({ tenantId: s.tenantA }, async (tx) => {
      const out: any[] = [];
      for (const sql of [
        `explain (analyze, format json) select * from usuario where id = '${s.uB}'::uuid`,
        `explain (analyze, format json) select * from tenant where id = '${s.tenantB}'::uuid`,
        `explain (analyze, format json) select * from usuario where email = 'ub@seed.contapp.test'`,
      ]) {
        out.push((await tx.query(sql)).rows[0]["QUERY PLAN"][0].Plan);
      }
      return out;
    });
    for (const p of planes) expect(p["Actual Rows"]).toBe(0);
  });

  it("pg_stats no expone valores de columnas de tablas con RLS a los roles de la app", async () => {
    for (const db of [backend, worker]) {
      const n = await db.withTenant({ tenantId: tenantDe("A") }, async (tx) =>
        (await tx.query(
          `select count(*)::int as n from pg_stats where schemaname = 'public'
              and tablename in ('tenant','usuario','membresia','cliente')`,
        )).rows[0].n,
      );
      expect(n).toBe(0);
    }
  });

  it("funciones que ejecutan SQL (query_to_xml, table_to_xml) aplican RLS del estudio actual", async () => {
    const s = semilla();
    const xml = await backend.withTenant({ tenantId: s.tenantA }, async (tx) =>
      [
        (await tx.query(`select query_to_xml('select id, email from usuario', false, false, '')::text as x`)).rows[0].x,
        (await tx.query(`select table_to_xml('public.tenant'::regclass, false, false, '')::text as x`)).rows[0].x,
        (await tx.query(`select query_to_xml('select id from cliente', false, false, '')::text as x`)).rows[0].x,
      ].join("\n"),
    );
    const ajenos = [s.uB, "ub@seed.contapp.test", s.tenantB, ...clientesDe("B").map((c) => c.id)];
    expect(ajenos.filter((v) => xml.includes(v))).toEqual([]);
    expect(xml.includes(s.uA)).toBe(true);
  });
});

describe("ADV2 limpieza de la conexion del pool entre transacciones (poolMax 1)", () => {
  it("un cursor WITH HOLD sobre usuario/tenant abierto en A no se puede leer desde withTenant(B)", async () => {
    const db = crearDb("contapp_backend", 1);
    try {
      await db.withTenant({ tenantId: tenantDe("A") }, async (tx) => {
        await tx.query(`declare adv2_u cursor with hold for select id from usuario`);
        await tx.query(`declare adv2_t cursor with hold for select id from tenant`);
      });
      const r = await db.withTenant({ tenantId: tenantDe("B") }, async (tx) => ({
        u: await capturar(tx, `fetch all from adv2_u`),
        t: await capturar(tx, `fetch all from adv2_t`),
      }));
      expect(r.u.ok).toBe(false);
      expect(r.t.ok).toBe(false);
    } finally {
      await db.close();
    }
  });

  it("sentencias preparadas (PREPARE, tambien via DO) en A no entregan datos de A dentro de withTenant(B)", async () => {
    const db = crearDb("contapp_backend", 1);
    const idsA = clientesDe("A").map((c) => c.id);
    try {
      await db.withTenant({ tenantId: tenantDe("A") }, async (tx) => {
        await capturar(tx, `prepare adv2_p as select id::text as id from cliente`);
        await capturar(
          tx,
          `do $$ begin execute format('prepare adv2_q as select %L::text as id',
              (select string_agg(id::text, ',') from cliente)); end $$`,
        );
      });
      const r = await db.withTenant({ tenantId: tenantDe("B") }, async (tx) => [
        await capturar(tx, `execute adv2_p`),
        await capturar(tx, `execute adv2_q`),
      ]);
      const vistos = r.flatMap((x) => (x.ok ? (x.rows ?? []).map((f) => String(f.id)) : [])).join(",");
      expect(idsA.filter((id) => vistos.includes(id))).toEqual([]);
      // Higiene: no debe quedar ninguna sentencia preparada por SQL de una peticion anterior.
      const quedan = await db.withTenant({ tenantId: tenantDe("B") }, async (tx) =>
        (await tx.query(`select name from pg_prepared_statements where name like 'adv2_%' order by name`)).rows.map(
          (x) => x.name as string,
        ),
      );
      expect(quedan).toEqual([]);
    } finally {
      await db.pool.query(`deallocate all`).catch(() => undefined);
      await db.close();
    }
  });

  it("LISTEN, advisory locks de sesion y GUC de aplicacion fijados en A no sobreviven en la siguiente peticion", async () => {
    const db = crearDb("contapp_backend", 1);
    try {
      const pid0 = await db.withTenant({ tenantId: tenantDe("A"), userId: semilla().uA }, async (tx) => {
        await tx.query(`listen adv2_canal`);
        await tx.query(`select pg_advisory_lock(424242)`);
        await tx.query(`select set_config('contapp.marca', $1, false)`, [tenantDe("A")]);
        await tx.query(`select set_config('app.user_id', $1, false)`, [semilla().uB]);
        await tx.query(`set session search_path = pg_catalog`);
        return (await tx.query(`select pg_backend_pid() as pid`)).rows[0].pid as number;
      });
      const r = await db.withTenant({ tenantId: tenantDe("B") }, async (tx) =>
        (await tx.query(
          `select pg_backend_pid() as pid,
                  (select count(*)::int from pg_listening_channels()) as canales,
                  (select count(*)::int from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()) as locks,
                  coalesce(current_setting('contapp.marca', true), '') as marca,
                  coalesce(current_setting('app.user_id', true), '') as usuario,
                  current_setting('search_path') as sp`,
        )).rows[0],
      );
      expect(r.pid).toBe(pid0);
      expect(r).toMatchObject({ canales: 0, locks: 0, marca: "", usuario: "" });
      expect(r.sp).not.toBe("pg_catalog");
    } finally {
      await db.close();
    }
  });

  it("withTenant no hereda una transaccion que otra parte del codigo dejo abierta en la conexion del pool", async () => {
    const db = crearDb("contapp_backend", 1);
    try {
      const c = await db.pool.connect();
      await c.query(`begin`);
      await c.query(`select pg_sleep(0.05)`);
      const tsSucio = (await c.query(`select now()::text as t`)).rows[0].t as string;
      c.release(); // devuelta al pool con la transaccion abierta (pg no hace ROLLBACK al liberar)
      const r = await db.withTenant({ tenantId: tenantDe("A") }, async (tx) =>
        (await tx.query(`select now()::text as t, current_user as u`)).rows[0],
      );
      expect(r.u).toBe("contapp_backend");
      expect(r.t).not.toBe(tsSucio); // si coincide, fn corrio (y se confirmo) dentro de la tx ajena
    } finally {
      await db.close();
    }
  });

  it("objetos grandes: lo creado en withTenant(A) no es legible desde withTenant(B) (almacen fuera de RLS)", async () => {
    const db = crearDb("contapp_backend");
    let oid: number | undefined;
    try {
      const creado = await db.withTenant({ tenantId: tenantDe("A") }, async (tx) =>
        capturar(
          tx,
          `select lo_from_bytea(0, convert_to((select string_agg(id::text, ',') from cliente), 'UTF8'))::int8 as oid`,
        ),
      );
      if (creado.ok) oid = Number(creado.rows![0].oid);
      const leido =
        oid === undefined
          ? { ok: false as const, code: "", message: "" }
          : await db.withTenant({ tenantId: tenantDe("B") }, async (tx) =>
              capturar(tx, `select convert_from(lo_get($1::oid), 'UTF8') as t`, [oid]),
            );
      const texto = leido.ok ? String(leido.rows![0].t) : "";
      const filtrados = clientesDe("A").filter((c) => texto.includes(c.id));
      expect({ creado: creado.ok, filtradosEnB: filtrados.length }).toEqual({ creado: false, filtradosEnB: 0 });
    } finally {
      if (oid !== undefined) {
        await db
          .withTenant({ tenantId: tenantDe("A") }, async (tx) => tx.query(`select lo_unlink($1::oid)`, [oid]))
          .catch(() => undefined);
      }
      await db.close();
    }
  });
});

describe("ADV2 reparar-rol (H7, D10) e idempotencia de migrar", () => {
  let pool: Pool;
  const dirDb = fileURLToPath(new URL("../../packages/db", import.meta.url));
  const migrar = () =>
    execFileSync(process.execPath, ["--env-file-if-exists=../../.env", "dist/cli/migrar.js"], {
      cwd: dirDb,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const ajustes = async () =>
    (
      await pool.query(
        `select s.setdatabase::int as db, s.setconfig as cfg from pg_db_role_setting s
           join pg_roles r on r.oid = s.setrole where r.rolname = 'contapp_app' order by 1`,
      )
    ).rows.map((f) => ({ db: f.db as number, cfg: ordenar(f.cfg as string[]) }));
  const LIMPIAR_ATAQUE = `do $$ begin
      alter role contapp_app reset statement_timeout;
      alter role contapp_app reset idle_in_transaction_session_timeout;
      execute format('alter role contapp_app in database %I reset all', current_database());
    end $$`;

  beforeAll(() => {
    pool = abrirPool(1);
  });
  afterAll(async () => {
    await pool.query(LIMPIAR_ATAQUE).catch(() => undefined);
    await pool?.end();
  });

  it("tras persistir ajustes por defecto desde el login, migrar los repara, no imprime secretos y la 2a corrida no cambia nada", async () => {
    // Ataque H7 (persistente, inocuo y revertido en afterAll si algo falla).
    await pool.query(`alter role contapp_app set statement_timeout = '43210'`);
    await pool.query(`alter role contapp_app set idle_in_transaction_session_timeout = '43210'`);
    await pool.query(
      `do $$ begin execute format('alter role contapp_app in database %I set work_mem = %L', current_database(), '8MB'); end $$`,
    );
    expect((await ajustes()).length).toBeGreaterThan(1);

    const out1 = migrar();
    expect(await ajustes()).toEqual([{ db: 0, cfg: ["lc_messages=C"] }]);
    expect(out1).toMatch(/ajustes de contapp_app reparados/);

    const out2 = migrar();
    expect(out2).toMatch(/ajustes de contapp_app sin cambios/);
    expect(out2).toMatch(/atributos de contapp_app sin cambios/);
    expect(out2).toMatch(/contrasena de contapp_app sin cambios/);
    expect(await ajustes()).toEqual([{ db: 0, cfg: ["lc_messages=C"] }]);

    const pw = decodeURIComponent(new URL(String(process.env.DATABASE_URL)).password);
    const salida = out1 + out2;
    expect(pw.length > 0 && salida.includes(pw)).toBe(false);
    expect(/postgres(ql)?:\/\//i.test(salida)).toBe(false);

    // Las politicas de 0003 siguen en su sitio tras reparar y volver a migrar (spec 004 agrega auth_definer y la 005 auth_definer_insert, que no cuentan; ajuste de 005 T2).
    const pol = (
      await pool.query(
        `select c.relname, c.relrowsecurity and c.relforcerowsecurity as rls, count(p.polname) filter (where p.polname not in ('auth_definer', 'auth_definer_insert', 'auth_definer_update'))::int as n
           from pg_class c left join pg_policy p on p.polrelid = c.oid
          where c.relnamespace = 'public'::regnamespace and c.relname in ('tenant','usuario')
          group by 1, 2 order by 1`,
      )
    ).rows;
    expect(pol).toEqual([
      { relname: "tenant", rls: true, n: 1 },
      { relname: "usuario", rls: true, n: 1 },
    ]);
    // Una conexion nueva arranca sin los valores inyectados.
    const nueva = abrirPool(1);
    try {
      const r = (await nueva.query(`select current_setting('statement_timeout') as st, current_setting('work_mem') as wm`))
        .rows[0];
      expect(r.st).not.toBe("43210ms");
      expect(r.wm).not.toBe("8MB");
    } finally {
      await nueva.end();
    }
  }, 60_000);
});

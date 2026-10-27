// Spec 003 · T14a · Ronda adversarial 1a (caja negra), parte BD: contapp_backend leyendo el sobre por vías
// SQL no cubiertas por credencial.spec.ts (objetos del catálogo, MERGE, EXPLAIN, TABLE, estadísticas).
// Sobres sintéticos (bytes aleatorios); todo ocurre en transacciones que se revierten.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirPool, semilla } from "./soporte";

const SENSIBLES = ["ciphertext", "nonce", "tag", "dek_envuelta"];
const INSERT_SQL = `insert into credencial (cliente_id, tipo, ciphertext, nonce, tag, dek_envuelta, kek_id, version)
                    values ($1, $2, $3, $4, $5, $6, 'k1', 1) returning id`;

let pool: Pool;
let poolSuper: Pool | undefined;
beforeAll(() => {
  pool = abrirPool();
  const url = process.env.MIGRATIONS_DATABASE_URL;
  if (url) poolSuper = new Pool({ connectionString: url, max: 1 });
});
afterAll(async () => {
  await pool?.end();
  await poolSuper?.end();
});

async function enRollback<T>(p: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await p.connect();
  try {
    await c.query("BEGIN");
    return await fn(c);
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    c.release();
  }
}

/** Siembra `n` credenciales como contapp_backend en el tenant A; deja la sesión en ese rol. */
async function sembrar(c: PoolClient, n = 1) {
  await c.query("select set_config('app.tenant_id', $1, true)", [semilla().tenantA]);
  await c.query("SET LOCAL ROLE contapp_backend");
  const filas: { id: string; hex: string[] }[] = [];
  for (let i = 0; i < n; i++) {
    const s = [randomBytes(64), randomBytes(12), randomBytes(16), randomBytes(512)];
    const r = await c.query(INSERT_SQL, [randomUUID(), i % 2 ? "sire_api" : "sol", ...s]);
    filas.push({ id: r.rows[0].id, hex: s.map((b) => b.toString("hex")) });
  }
  return filas;
}

async function intentar(c: PoolClient, sql: string, values: unknown[] = []) {
  await c.query("SAVEPOINT sp");
  try {
    await c.query(sql, values);
    await c.query("RELEASE SAVEPOINT sp");
    return { ok: true as const, code: "" };
  } catch (e) {
    await c.query("ROLLBACK TO SAVEPOINT sp");
    return { ok: false as const, code: String((e as { code?: string }).code ?? "") };
  }
}

describe("R1a · catálogo: ningún objeto expone el sobre a contapp_backend", () => {
  it("sin vistas, vistas materializadas, funciones SECURITY DEFINER ni reglas que lean el sobre", async () => {
    const sens = "(ciphertext|nonce|dek_envuelta|\\mtag\\M)";
    const vistas = await pool.query(
      `select c.oid::regclass::text as obj
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('v','m')
          and n.nspname not in ('pg_catalog','information_schema')
          and pg_get_viewdef(c.oid) ~* 'credencial'
          and pg_get_viewdef(c.oid) ~* $1
          and has_table_privilege('contapp_backend', c.oid, 'SELECT')`,
      [sens],
    );
    expect(vistas.rows.map((r) => r.obj), "vistas que exponen el sobre al backend").toEqual([]);

    const funciones = await pool.query(
      `select p.oid::regprocedure::text as obj
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname not in ('pg_catalog','information_schema')
          and p.prosecdef
          and coalesce(p.prosrc, '') ~* 'credencial'
          and has_function_privilege('contapp_backend', p.oid, 'EXECUTE')`,
    );
    expect(
      funciones.rows.map((r) => r.obj),
      "funciones SECURITY DEFINER sobre credencial ejecutables por el backend",
    ).toEqual([]);

    const reglas = await pool.query(
      "select rulename from pg_rules where schemaname = 'public' and tablename = 'credencial'",
    );
    expect(reglas.rows, "reglas sobre credencial").toEqual([]);
  });
});

describe("R1a · oráculos SQL no cubiertos: permission denied (42501)", () => {
  const casos: Array<[string, string, (id: string) => unknown[]]> = [
    [
      "MERGE ... ON nonce = <valor>",
      `merge into credencial c using (select $1::bytea as n) s on c.nonce = s.n
         when matched then update set kek_id = 'k9'`,
      () => [Buffer.alloc(12)],
    ],
    [
      "MERGE ... WHEN MATCHED AND tag = <valor>",
      `merge into credencial c using (select $1::uuid as id) s on c.id = s.id
         when matched and c.tag = '\\x00'::bytea then update set kek_id = 'k9'`,
      (id) => [id],
    ],
    [
      "MERGE ... UPDATE SET ciphertext = c.ciphertext",
      `merge into credencial c using (select $1::uuid as id) s on c.id = s.id
         when matched then update set ciphertext = c.ciphertext`,
      (id) => [id],
    ],
    [
      "MERGE ... RETURNING dek_envuelta",
      `merge into credencial c using (select $1::uuid as id) s on c.id = s.id
         when matched then update set kek_id = 'k9' returning c.dek_envuelta`,
      (id) => [id],
    ],
    [
      "EXPLAIN (estimación de filas como oráculo)",
      "explain select id from credencial where ciphertext = '\\x00'::bytea",
      () => [],
    ],
    [
      "EXPLAIN ANALYZE con WHERE sobre dek_envuelta",
      "explain analyze select id from credencial where length(dek_envuelta) > 0",
      () => [],
    ],
    ["TABLE credencial", "table credencial", () => []],
    ["comparación de fila completa", "select id from credencial c where c = c", () => []],
    [
      "DECLARE CURSOR sobre el sobre",
      "declare cur cursor for select nonce from credencial",
      () => [],
    ],
  ];

  it.each(casos)("%s", async (_n, sql, args) => {
    const r = await enRollback(pool, async (c) => {
      const [fila] = await sembrar(c);
      return intentar(c, sql, args(fila.id));
    });
    expect(r.ok, "la consulta debió rechazarse").toBe(false);
    expect(r.code).toBe("42501");
  });
});

describe("R1a · estadísticas del planificador", () => {
  it("tras ANALYZE, pg_stats no muestra a contapp_backend valores del sobre", async () => {
    if (!poolSuper) throw new Error("falta MIGRATIONS_DATABASE_URL para correr ANALYZE");
    const r = await enRollback(poolSuper, async (c) => {
      const filas = await sembrar(c, 6);
      await c.query("RESET ROLE");
      await c.query("ANALYZE credencial");
      const control = await c.query(
        "select count(*)::int as n from pg_stats where tablename = 'credencial' and attname = any($1)",
        [SENSIBLES],
      );
      await c.query("SET LOCAL ROLE contapp_backend");
      const visto = await c.query(
        `select attname, coalesce(most_common_vals::text,'') || coalesce(histogram_bounds::text,'') as v
           from pg_stats where tablename = 'credencial'`,
      );
      return { filas, control: control.rows[0].n as number, visto: visto.rows };
    });
    expect(r.control, "control: ANALYZE debió generar estadísticas del sobre").toBeGreaterThan(0);
    const cols = r.visto.map((x: { attname: string }) => x.attname);
    expect(cols.filter((c: string) => SENSIBLES.includes(c)), "columnas del sobre en pg_stats").toEqual([]);
    const texto = r.visto.map((x: { v: string }) => x.v).join("\n");
    const fuga = r.filas.some((f) => f.hex.some((h) => texto.includes(h)));
    expect(fuga, "bytes del sobre visibles en pg_stats").toBe(false);
  });
});

// CA-4 (falla cerrado): sin withTenant, 0 filas / INSERT rechazado; el rol de login sin SET ROLE no tiene permisos.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  abrirPool,
  crearDb,
  filasRaw,
  intentarRaw,
  ROLES_APP,
  TABLAS_NEGOCIO,
  semilla,
  tenantDe,
  type ContappDb,
  type TablaNegocio,
} from "./soporte";

let pool: Pool;
beforeAll(() => {
  pool = abrirPool();
});
afterAll(async () => {
  await pool.end();
});

function insertDe(tabla: TablaNegocio): [string, unknown[]] {
  const A = semilla().tenantA;
  return tabla === "cliente"
    ? [`insert into cliente (tenant_id, ruc, razon_social) values ($1, '20999999991', 'Intruso')`, [A]]
    : [`insert into membresia (tenant_id, usuario_id, rol) values ($1, $2, 'admin')`, [A, semilla().uB]];
}

describe.each(ROLES_APP)("CA-4 %s sin withTenant", (rolApp) => {
  let db: ContappDb;
  beforeAll(() => {
    db = crearDb(rolApp);
  });
  afterAll(async () => {
    await db?.close();
  });

  it.each(TABLAS_NEGOCIO)("%s: hay datos con tenant y 0 filas sin tenant", async (tabla) => {
    const conTenant = await db.withTenant({ tenantId: tenantDe("A") }, async (tx) =>
      Number((await tx.query(`select count(*)::int as n from ${tabla}`)).rows[0].n),
    );
    expect(conTenant).toBeGreaterThan(0);
    const filas = await filasRaw(pool, rolApp, `select * from ${tabla}`);
    expect(filas).toHaveLength(0);
  });

  it.each(TABLAS_NEGOCIO)("%s: INSERT sin tenant fijado es rechazado", async (tabla) => {
    const [sql, valores] = insertDe(tabla);
    const r = await intentarRaw(pool, rolApp, sql, valores);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("42501"); // viola la politica RLS (WITH CHECK)
  });

  it.each(TABLAS_NEGOCIO)("%s: UPDATE y DELETE sin tenant afectan 0 filas", async (tabla) => {
    const u = await intentarRaw(pool, rolApp, `update ${tabla} set tenant_id = tenant_id`);
    const d = await intentarRaw(pool, rolApp, `delete from ${tabla}`);
    expect(u).toEqual({ ok: true, rowCount: 0 });
    expect(d).toEqual({ ok: true, rowCount: 0 });
  });

  it("con app.tenant_id vacio (rastro de una conexion reutilizada) tambien falla cerrado", async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SET LOCAL ROLE ${rolApp}`);
      await c.query("select set_config('app.tenant_id', '', true)");
      for (const t of TABLAS_NEGOCIO) {
        expect((await c.query(`select * from ${t}`)).rows, t).toHaveLength(0);
      }
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  });
});

describe("CA-4 rol de login sin SET ROLE", () => {
  it.each([...TABLAS_NEGOCIO, "tenant", "usuario"])("SELECT sobre %s recibe permission denied", async (tabla) => {
    const r = await intentarRaw(pool, null, `select * from ${tabla}`);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("42501");
      expect(r.message).toMatch(/permission denied/i);
    }
  });

  it.each(TABLAS_NEGOCIO)("INSERT, UPDATE y DELETE sobre %s reciben permission denied", async (tabla) => {
    const [ins, valores] = insertDe(tabla);
    for (const [sql, v] of [
      [ins, valores],
      [`update ${tabla} set tenant_id = tenant_id`, []],
      [`delete from ${tabla}`, []],
    ] as [string, unknown[]][]) {
      const r = await intentarRaw(pool, null, sql, v);
      expect(r.ok, sql).toBe(false);
      if (!r.ok) expect(r.code, sql).toBe("42501");
    }
  });

  it.each(ROLES_APP)("db.pool de createDb(%s) usado fuera de withTenant no lee tablas de negocio", async (rolApp) => {
    const db = crearDb(rolApp);
    try {
      for (const t of TABLAS_NEGOCIO) {
        await expect(db.pool.query(`select * from ${t}`), t).rejects.toMatchObject({ code: "42501" });
      }
    } finally {
      await db.close();
    }
  });
});

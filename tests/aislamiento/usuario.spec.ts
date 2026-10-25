// P7: withUsuario lista las membresias de un usuario antes de elegir estudio (politica membresia_por_usuario).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crearDb, ROLES_APP, semilla, tenantDe, type ContappDb } from "./soporte";

class Revertir extends Error {}

describe.each(ROLES_APP)("P7 rol %s", (rolApp) => {
  let db: ContappDb;
  beforeAll(() => {
    db = crearDb(rolApp);
  });
  afterAll(async () => {
    await db?.close();
  });

  const membresias = (userId: string) =>
    db.withUsuario(
      { userId },
      async (tx) => (await tx.query("select usuario_id, tenant_id from membresia order by tenant_id")).rows,
    );

  it("withUsuario(uAB) ve 2 membresias, una por estudio", async () => {
    const r = await membresias(semilla().uAB);
    expect(r).toHaveLength(2);
    expect(r.every((x) => x.usuario_id === semilla().uAB)).toBe(true);
    expect(r.map((x) => x.tenant_id).sort()).toEqual([tenantDe("A"), tenantDe("B")].sort());
  });

  it("withUsuario(uA) ve 1 membresia (A) y withUsuario(uB) ve 1 (B)", async () => {
    const a = await membresias(semilla().uA);
    const b = await membresias(semilla().uB);
    expect(a.map((x) => x.tenant_id)).toEqual([tenantDe("A")]);
    expect(b.map((x) => x.tenant_id)).toEqual([tenantDe("B")]);
  });

  it("un usuario inexistente ve 0 membresias", async () => {
    expect(await membresias("00000000-0000-4000-8000-000000000000")).toHaveLength(0);
  });

  it("sin usuario ni tenant (conexion sin contexto) se ven 0 membresias", async () => {
    const c = await db.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SET LOCAL ROLE ${rolApp}`);
      expect((await c.query("select * from membresia")).rows).toHaveLength(0);
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  });

  it("con tenant fijado la politica por usuario no aplica: withTenant(A, uAB) ve solo las de A", async () => {
    const r = await db.withTenant(
      { tenantId: tenantDe("A"), userId: semilla().uAB },
      async (tx) => (await tx.query("select usuario_id, tenant_id from membresia")).rows,
    );
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((x) => x.tenant_id === tenantDe("A"))).toBe(true);
    expect(r.some((x) => x.tenant_id === tenantDe("B"))).toBe(false);
  });

  it("withUsuario no da acceso a cliente (0 filas)", async () => {
    const r = await db.withUsuario(
      { userId: semilla().uAB },
      async (tx) => (await tx.query("select * from cliente")).rows,
    );
    expect(r).toHaveLength(0);
  });

  it("withUsuario es solo lectura de membresia: INSERT rechazado, UPDATE y DELETE afectan 0 filas", async () => {
    const { uAB, uB } = semilla();
    const sentencias: [string, unknown[]][] = [
      ["insert into membresia (tenant_id, usuario_id, rol) values ($1, $2, 'admin')", [tenantDe("A"), uB]],
      ["update membresia set rol = 'hackeado'", []],
      ["delete from membresia", []],
    ];
    const salidas: unknown[] = [];
    for (const [sql, valores] of sentencias) {
      // siempre se revierte, aunque una implementacion defectuosa dejara pasar la sentencia
      await db
        .withUsuario({ userId: uAB }, async (tx) => {
          try {
            salidas.push((await tx.query(sql, valores)).rowCount);
          } catch (e) {
            salidas.push((e as { code?: string }).code);
          }
          throw new Revertir();
        })
        .catch((e) => {
          if (!(e instanceof Revertir)) throw e;
        });
    }
    expect(salidas).toEqual(["42501", 0, 0]);
    expect(await membresias(uAB)).toHaveLength(2);
  });
});

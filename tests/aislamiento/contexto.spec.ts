// CA-6 (el contexto no se filtra): la conexion del pool queda limpia tras commit, rollback y excepcion;
// y dos withTenant concurrentes (A y B) nunca ven datos cruzados.
import { afterAll, describe, expect, it } from "vitest";
import { crearDb, ROLES_APP, semilla, tenantDe, clientesDe, type ContappDb, type Estudio } from "./soporte";

const CONTEXTO = `select current_setting('app.tenant_id', true) as t,
                         current_setting('app.user_id', true) as u,
                         current_user as rol,
                         pg_backend_pid() as pid`;

class Falla extends Error {}

describe.each(ROLES_APP)("CA-6 rol %s", (rolApp) => {
  const abiertas: ContappDb[] = [];
  const nuevaDb = (poolMax?: number) => {
    const d = crearDb(rolApp, poolMax);
    abiertas.push(d);
    return d;
  };
  afterAll(async () => {
    await Promise.all(abiertas.map((d) => d.close()));
  });

  async function verificarLimpia(db: ContappDb, pidDentro: number) {
    const r = (await db.pool.query(CONTEXTO)).rows[0];
    expect(r.pid, "debe ser la misma conexion (poolMax: 1)").toBe(pidDentro);
    expect(r.t === null || r.t === "", "app.tenant_id quedo fijado").toBe(true);
    expect(r.u === null || r.u === "", "app.user_id quedo fijado").toBe(true);
    expect(r.rol).toBe("contapp_app");
    await expect(db.pool.query("select * from cliente")).rejects.toMatchObject({ code: "42501" });
  }

  it("tras commit la conexion queda sin app.tenant_id ni app.user_id", async () => {
    const db = nuevaDb(1);
    const dentro = await db.withTenant({ tenantId: tenantDe("A"), userId: semilla().uA }, async (tx) => {
      const r = (await tx.query(CONTEXTO)).rows[0];
      expect(r.t).toBe(tenantDe("A"));
      const n = Number((await tx.query("select count(*)::int as n from cliente")).rows[0].n);
      expect(n).toBeGreaterThan(0);
      return r.pid as number;
    });
    await verificarLimpia(db, dentro);
  });

  it("tras rollback (excepcion de SQL dentro de la transaccion) la conexion queda limpia", async () => {
    const db = nuevaDb(1);
    let pid = 0;
    await expect(
      db.withTenant({ tenantId: tenantDe("A") }, async (tx) => {
        pid = (await tx.query(CONTEXTO)).rows[0].pid;
        await tx.query("select * from tabla_que_no_existe");
      }),
    ).rejects.toMatchObject({ code: "42P01" });
    await verificarLimpia(db, pid);
  });

  it("tras una excepcion de la aplicacion dentro de withTenant la conexion queda limpia", async () => {
    const db = nuevaDb(1);
    let pid = 0;
    await expect(
      db.withTenant({ tenantId: tenantDe("B") }, async (tx) => {
        pid = (await tx.query(CONTEXTO)).rows[0].pid;
        throw new Falla("boom");
      }),
    ).rejects.toBeInstanceOf(Falla);
    await verificarLimpia(db, pid);
  });

  it("tras withUsuario la conexion queda limpia", async () => {
    const db = nuevaDb(1);
    const pid = await db.withUsuario({ userId: semilla().uAB }, async (tx) => {
      const r = (await tx.query(CONTEXTO)).rows[0];
      expect(r.u).toBe(semilla().uAB);
      return r.pid as number;
    });
    await verificarLimpia(db, pid);
  });

  it("con poolMax 1, un withTenant(B) tras withTenant(A) no ve rastro de A", async () => {
    const db = nuevaDb(1);
    await db.withTenant({ tenantId: tenantDe("A") }, async (tx) => {
      await tx.query("select 1 from cliente");
    });
    const filas = await db.withTenant(
      { tenantId: tenantDe("B") },
      async (tx) => (await tx.query("select id, tenant_id from cliente")).rows,
    );
    expect(filas.map((f) => f.id).sort()).toEqual(
      clientesDe("B")
        .map((c) => c.id)
        .sort(),
    );
    expect(filas.every((f) => f.tenant_id === tenantDe("B"))).toBe(true);
  });

  it("50 pares concurrentes A/B (con pg_sleep) nunca ven datos cruzados", { timeout: 60_000 }, async () => {
    const db = nuevaDb(10);
    const una = async (e: Estudio) =>
      db.withTenant({ tenantId: tenantDe(e) }, async (tx) => {
        await tx.query("select pg_sleep($1)", [Math.random() * 0.04]);
        const t = (await tx.query("select current_setting('app.tenant_id', true) as t")).rows[0].t;
        await tx.query("select pg_sleep($1)", [Math.random() * 0.02]);
        const filas = (await tx.query("select id, tenant_id from cliente")).rows;
        return { e, t, filas };
      });
    const lanzadas: Promise<{ e: Estudio; t: string; filas: { id: string; tenant_id: string }[] }>[] = [];
    for (let i = 0; i < 50; i++) lanzadas.push(una("A"), una("B"));
    const resultados = await Promise.all(lanzadas);
    expect(resultados).toHaveLength(100);
    for (const r of resultados) {
      expect(r.t).toBe(tenantDe(r.e));
      expect(r.filas.length).toBe(clientesDe(r.e).length);
      expect(r.filas.every((f) => f.tenant_id === tenantDe(r.e))).toBe(true);
      expect(r.filas.map((f) => f.id).sort()).toEqual(
        clientesDe(r.e)
          .map((c) => c.id)
          .sort(),
      );
    }
  });
});

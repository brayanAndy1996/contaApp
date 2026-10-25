// Ronda adversarial 1 (T8, spec 002): cambio de tenant a mitad de transaccion, estado de sesion
// que sobrevive en el pool (set_config no local, SET ROLE de sesion), tx filtrada fuera de su
// withTenant y valores invalidos o con inyeccion en app.tenant_id. Solo DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  abrirPool,
  clientesDe,
  crearDb,
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

/** Estado de la unica conexion de un pool con max 1, leido fuera de withTenant. */
async function estadoConexion(db: ContappDb) {
  const r = await db.pool.query(
    `select current_user as u, coalesce(current_setting('app.tenant_id', true), '') as t,
            coalesce(current_setting('app.user_id', true), '') as us, pg_backend_pid() as pid`,
  );
  return r.rows[0] as { u: string; t: string; us: string; pid: number };
}

const idsB = () => clientesDe("B").map((c) => c.id);

describe("ADV contexto de tenant (rol contapp_backend)", () => {
  it("set_config('app.tenant_id', B, true) a mitad de withTenant(A) no da acceso a filas de B", async () => {
    const db = crearDb("contapp_backend");
    try {
      const vistos = await db.withTenant(
        { tenantId: tenantDe("A") },
        async (tx) => {
          await tx.query(`select set_config('app.tenant_id', $1, true)`, [
            tenantDe("B"),
          ]);
          return (await tx.query(`select id from cliente`)).rows.map(
            (x) => x.id as string,
          );
        },
      );
      expect(vistos.some((id) => idsB().includes(id))).toBe(false);
    } finally {
      await db.close();
    }
  });

  it("set_config(..., false) dentro de withTenant no sobrevive en el pool ni se filtra a un withUsuario posterior", async () => {
    const db = crearDb("contapp_backend", 1);
    try {
      const pid0 = await db.withTenant(
        { tenantId: tenantDe("A") },
        async (tx) => {
          await tx.query(`select set_config('app.tenant_id', $1, false)`, [
            tenantDe("B"),
          ]);
          return (await tx.query(`select pg_backend_pid() as pid`)).rows[0]
            .pid as number;
        },
      );
      const est = await estadoConexion(db);
      expect(est.pid).toBe(pid0); // misma conexion fisica (poolMax 1)
      // Siguiente peticion, de otro usuario y sin tenant: no debe ver clientes de B.
      const visto = await db.withUsuario(
        { userId: semilla().uA },
        async (tx) => ({
          clientes: (await tx.query(`select id from cliente`)).rows.map(
            (x) => x.id as string,
          ),
          membresias: (
            await tx.query(`select tenant_id from membresia`)
          ).rows.map((x) => x.tenant_id as string),
        }),
      );
      expect(visto.clientes).toEqual([]);
      expect(visto.membresias).toEqual([tenantDe("A")]);
      expect(est.t).toBe("");
    } finally {
      await db.close();
    }
  });

  it("SET ROLE de sesion dentro de withTenant no deja la conexion del pool con otro rol", async () => {
    const db = crearDb("contapp_backend", 1);
    try {
      await db.withTenant({ tenantId: tenantDe("A") }, async (tx) => {
        await tx.query(`set role contapp_platform`);
      });
      const est = await estadoConexion(db);
      expect(est.u).toBe("contapp_app");
    } finally {
      await db.close();
    }
  });

  it("una tx filtrada fuera de su withTenant(A) no puede consultar dentro de un withTenant(B) posterior", async () => {
    const db = crearDb("contapp_backend", 1);
    try {
      let fuga: Tx | undefined;
      await db.withTenant({ tenantId: tenantDe("A") }, async (tx) => {
        fuga = tx;
      });
      const r = await db.withTenant({ tenantId: tenantDe("B") }, async () =>
        capturar(fuga as Tx, `select id from cliente`),
      );
      expect(r.ok).toBe(false);
      const sueltaFuera = await capturar(fuga as Tx, `select 1`);
      expect(sueltaFuera.ok).toBe(false);
    } finally {
      await db.close();
    }
  });

  describe("app.tenant_id invalido o con inyeccion (set_config crudo con contapp_backend)", () => {
    let pool: Pool;
    beforeAll(() => {
      pool = abrirPool(1);
    });
    afterAll(async () => {
      await pool?.end();
    });

    it("falla cerrado: error de tipo o 0 filas, sin datos del seed en el mensaje", async () => {
      const B = tenantDe("B");
      const A = tenantDe("A");
      const valores = [
        "no-uuid",
        "' or 1=1 --",
        "x'; drop table cliente; --",
        `${A},${B}`,
        `${B}' or '1'='1`,
        "null",
      ];
      const secretos = [...clientesDe("A"), ...clientesDe("B")].flatMap((c) => [
        c.id,
        c.ruc,
      ]);
      const fugas: string[] = [];
      for (const v of valores) {
        const c = await pool.connect();
        try {
          await c.query("BEGIN");
          await c.query("SET LOCAL ROLE contapp_backend");
          await c.query(`select set_config('app.tenant_id', $1, true)`, [v]);
          const r = await capturar(
            c as unknown as Tx,
            `select id, ruc from cliente`,
          );
          if (r.ok && r.rowCount !== 0)
            fugas.push(`${JSON.stringify(v)}: ${r.rowCount} filas`);
          if (!r.ok && secretos.some((s) => r.message.includes(s)))
            fugas.push(`${JSON.stringify(v)}: mensaje`);
        } finally {
          await c.query("ROLLBACK").catch(() => undefined);
          c.release();
        }
      }
      expect(fugas).toEqual([]);
    });
  });
});

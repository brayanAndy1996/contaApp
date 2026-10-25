// Ronda adversarial 1 (T8, spec 002): oraculos de existencia entre estudios (PK, ON CONFLICT, FK),
// orden de evaluacion de RLS frente a funciones que lanzan error y tablas de plataforma.
// Solo DATABASE_URL. Todo cambio se revierte (enRollback / intentar).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  clientesDe,
  crearDb,
  enRollback,
  intentar,
  semilla,
  tenantDe,
  type ContappDb,
  type Intento,
  type Tx,
} from "./soporte";

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

const sinMensaje = (r: Intento) => (r.ok ? r : { ok: false, code: r.code });

describe("ADV oraculos de existencia (rol contapp_backend)", () => {
  let db: ContappDb;
  let worker: ContappDb;
  beforeAll(() => {
    db = crearDb("contapp_backend");
    worker = crearDb("contapp_worker");
  });
  afterAll(async () => {
    await db?.close();
    await worker?.close();
  });

  const ctxA = () => ({ tenantId: tenantDe("A") });
  const membresiaB = () => "01920000-0000-7000-8000-0000000002b1"; // SEED.membresias[1] (uB en B)

  it("PK: insertar en A con el id de una fila de B se comporta igual que con un id libre", async () => {
    const idB = clientesDe("B")[0].id;
    const sql = `insert into cliente (id, tenant_id, ruc, razon_social) values ($1, $2, '20999999981', 'sonda')`;
    const conIdDeB = await intentar(db, ctxA(), sql, [idB, tenantDe("A")]);
    const conIdLibre = await intentar(db, ctxA(), sql, [
      randomUUID(),
      tenantDe("A"),
    ]);
    const msql = `insert into membresia (id, tenant_id, usuario_id, rol) values ($1, $2, $3, 'sonda')`;
    const mConIdDeB = await intentar(db, ctxA(), msql, [
      membresiaB(),
      tenantDe("A"),
      semilla().uB,
    ]);
    const mConIdLibre = await intentar(db, ctxA(), msql, [
      randomUUID(),
      tenantDe("A"),
      semilla().uB,
    ]);
    // Si difieren (23505 vs 1 fila), A puede confirmar que un UUID existe en otro estudio.
    expect(sinMensaje(conIdDeB)).toEqual(sinMensaje(conIdLibre));
    expect(sinMensaje(mConIdDeB)).toEqual(sinMensaje(mConIdLibre));
  });

  it("ON CONFLICT (id) DO NOTHING / DO UPDATE no distinguen un id de B de uno libre", async () => {
    const idB = clientesDe("B")[1].id;
    const nada = `insert into cliente (id, tenant_id, ruc, razon_social) values ($1, $2, '20999999982', 'sonda')
                  on conflict (id) do nothing`;
    const upd = `insert into cliente (id, tenant_id, ruc, razon_social) values ($1, $2, '20999999983', 'sonda')
                 on conflict (id) do update set razon_social = excluded.razon_social`;
    const r = await enRollback(db, ctxA(), async (tx) => ({
      nadaB: await capturar(tx, nada, [idB, tenantDe("A")]),
    }));
    const rLibre = await enRollback(db, ctxA(), async (tx) => ({
      nadaLibre: await capturar(tx, nada, [randomUUID(), tenantDe("A")]),
    }));
    const uB = await intentar(db, ctxA(), upd, [idB, tenantDe("A")]);
    const uLibre = await intentar(db, ctxA(), upd, [
      randomUUID(),
      tenantDe("A"),
    ]);
    // DO NOTHING devuelve 0 filas solo si el id ya existe (en cualquier estudio): oraculo silencioso.
    expect(r.nadaB).toEqual(rLibre.nadaLibre);
    expect(sinMensaje(uB)).toEqual(sinMensaje(uLibre));
  });

  it("FK: contapp_worker (sin SELECT en usuario) no puede sondear si un usuario existe via membresia", async () => {
    const lectura = await intentar(worker, ctxA(), `select id from usuario`);
    expect(lectura.ok).toBe(false); // control: worker no tiene SELECT sobre usuario
    const sql = `insert into membresia (tenant_id, usuario_id, rol) values ($1, $2, 'sonda')`;
    const existente = await intentar(worker, ctxA(), sql, [
      tenantDe("A"),
      semilla().uB,
    ]);
    const inexistente = await intentar(worker, ctxA(), sql, [
      tenantDe("A"),
      randomUUID(),
    ]);
    expect(sinMensaje(existente)).toEqual(sinMensaje(inexistente));
  });

  it("RLS se evalua antes que una expresion que lanza error sobre filas de B (sin oraculo por error)", async () => {
    // 1/(length(ruc)-11) no es constante (no se pliega al planificar) y divide por 0 en cualquier fila.
    const r = await intentar(
      db,
      ctxA(),
      `select id from cliente where (case when tenant_id = $1 then 1/(length(ruc)-11) else 1 end) = 1`,
      [tenantDe("B")],
    );
    expect(r).toEqual({ ok: true, rowCount: 3 });
    const porRuc = await intentar(
      db,
      ctxA(),
      `select id from cliente where (case when ruc = $1 then 1/(length(ruc)-11) else 1 end) = 1`,
      [clientesDe("B")[2].ruc], // RUC que solo existe en B
    );
    expect(porRuc).toEqual({ ok: true, rowCount: 3 });
  });

  it("dentro de withTenant(A) las tablas de plataforma no exponen usuarios ni estudios ajenos", async () => {
    const vistos = await db.withTenant(ctxA(), async (tx) => ({
      usuarios: (await tx.query(`select id from usuario`)).rows.map(
        (x) => x.id as string,
      ),
      tenants: (await tx.query(`select id from tenant`)).rows.map(
        (x) => x.id as string,
      ),
    }));
    // uB solo es miembro de B; B es otro estudio. HU-40: ningun estudio ve datos de otro.
    expect(vistos.usuarios).not.toContain(semilla().uB);
    expect(vistos.tenants).not.toContain(tenantDe("B"));
  });
});

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
  // ON CONFLICT DO UPDATE sobre una fila que la politica USING oculta: PG lo rechaza con 42501.
  const UPSERT_SOBRE_B = { ok: false, code: "42501" };

  // RIESGO ACEPTADO H4 (spec 002, "Riesgos aceptados"): oraculo de existencia por PK (23505).
  // Motivo: IDs UUID aleatorios (exige conocer un ID de otro estudio) y UNIQUE de RUC por estudio
  // (CA-7). Se fija el comportamiento conocido; si cambia, la prueba falla y obliga a revisarlo.
  it("H4 aceptado: insertar en A con el id de una fila de B da 23505; con un id libre inserta", async () => {
    const idB = clientesDe("B")[0].id;
    const sql = `insert into cliente (id, tenant_id, ruc, razon_social) values ($1, $2, '20999999981', 'sonda')`;
    const conIdDeB = await intentar(db, ctxA(), sql, [idB, tenantDe("A")]);
    const conIdLibre = await intentar(db, ctxA(), sql, [
      randomUUID(),
      tenantDe("A"),
    ]);
    // 005: rol 'lectura' (valido bajo el CHECK de D21) en lugar de 'sonda', que daba 23514 antes del 23505.
    const msql = `insert into membresia (id, tenant_id, usuario_id, rol) values ($1, $2, $3, 'lectura')`;
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
    // Difieren (23505 vs 1 fila): A puede confirmar que un UUID existe en otro estudio (aceptado).
    expect(sinMensaje(conIdDeB)).toEqual({ ok: false, code: "23505" });
    expect(conIdLibre).toEqual({ ok: true, rowCount: 1 });
    expect(sinMensaje(mConIdDeB)).toEqual({ ok: false, code: "23505" });
    expect(mConIdLibre).toEqual({ ok: true, rowCount: 1 });
    // El mensaje de 23505 no revela datos de la fila de B (solo la clave que A ya conoce).
    if (!conIdDeB.ok) expect(conIdDeB.message).not.toContain(clientesDe("B")[0].ruc);
  });

  // RIESGO ACEPTADO H5 (spec 002, "Riesgos aceptados"): oraculo por ON CONFLICT (id). Mismo motivo
  // que H4. Se fija el comportamiento conocido; si cambia, la prueba falla y obliga a revisarlo.
  it("H5 aceptado: ON CONFLICT (id) DO NOTHING / DO UPDATE distinguen un id de B de uno libre", async () => {
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
    expect(r.nadaB).toEqual({ ok: true, rowCount: 0 });
    expect(rLibre.nadaLibre).toEqual({ ok: true, rowCount: 1 });
    // DO UPDATE sobre la fila de B no la modifica: RLS lo rechaza con error (no 1 fila).
    expect(uB.ok).toBe(false);
    expect(sinMensaje(uB)).toEqual(UPSERT_SOBRE_B);
    expect(uLibre).toEqual({ ok: true, rowCount: 1 });
  });

  // RIESGO ACEPTADO H9 (spec 002, "Riesgos aceptados"): oraculo de existencia por FK (23503). Mismo
  // motivo que H4. Se fija el comportamiento conocido; si cambia, la prueba falla y obliga a revisarlo.
  it("H9 aceptado: contapp_worker (sin SELECT en usuario) distingue por FK si un usuario existe", async () => {
    const lectura = await intentar(worker, ctxA(), `select id from usuario`);
    expect(lectura.ok).toBe(false); // control: worker no tiene SELECT sobre usuario
    // 005: rol 'lectura' (valido bajo el CHECK de D21) en lugar de 'sonda', que daba 23514 antes del 23503.
    const sql = `insert into membresia (tenant_id, usuario_id, rol) values ($1, $2, 'lectura')`;
    const existente = await intentar(worker, ctxA(), sql, [
      tenantDe("A"),
      semilla().uB,
    ]);
    const inexistente = await intentar(worker, ctxA(), sql, [
      tenantDe("A"),
      randomUUID(),
    ]);
    expect(existente).toEqual({ ok: true, rowCount: 1 });
    expect(sinMensaje(inexistente)).toEqual({ ok: false, code: "23503" });
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

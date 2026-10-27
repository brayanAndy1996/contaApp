// T14a (005) · Ronda adversarial 1a, caja negra, en BD: último Dueño con sentencias de varias filas e IDOR
// de asignación entre estudios con `contapp_backend` dentro de `withTenant`. Todo con rollback o limpieza propia.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EscenarioAcceso } from "./acceso-soporte";
import { abrirAdmin, crearDb } from "./auth-soporte";
import { intentar, type ContappDb } from "./soporte";

let admin: Pool;
let ea: EscenarioAcceso;
let db: ContappDb;

beforeAll(() => {
  admin = abrirAdmin(3);
  ea = new EscenarioAcceso(admin);
  db = crearDb("contapp_backend", 2);
});
afterAll(async () => {
  await ea?.limpiar();
  await db?.close().catch(() => undefined);
  await admin?.end();
});

const estado = async (t: string) =>
  (
    await admin.query(
      "select usuario_id, rol, desactivada_en is null as activa from membresia where tenant_id = $1 order by usuario_id",
      [t],
    )
  ).rows;
const codigo = (r: { ok: boolean; code?: string }) => (r.ok ? "ok" : r.code);

describe("último Dueño con sentencias de varias filas (CA-10, D10)", () => {
  it("una sola sentencia que degrada o desactiva a TODOS los Dueños activos falla con P0001 y no cambia nada", async () => {
    const e = await ea.estudio();
    await ea.miembro(e.id, "dueno");
    await ea.miembro(e.id, "dueno");
    await ea.miembro(e.id, "admin");
    await ea.miembro(e.id, "dueno", { desactivada: true });
    const antes = await estado(e.id);
    const sentencias = [
      "update membresia set desactivada_en = now()",
      "update membresia set desactivada_en = now() where rol = 'dueno'",
      "update membresia set rol = 'admin' where rol = 'dueno'",
      "update membresia set rol = case when rol = 'dueno' then 'admin' else 'lectura' end",
      "update membresia set rol = 'admin', desactivada_en = null where rol = 'dueno'",
    ];
    const r: Record<string, unknown> = {};
    for (const s of sentencias) r[s] = codigo(await intentar(db, { tenantId: e.id }, s));
    expect(r).toEqual(Object.fromEntries(sentencias.map((s) => [s, "P0001"])));
    expect(await estado(e.id)).toEqual(antes);
  });

});

describe("IDOR de asignación entre estudios en BD (CA-12, CA-13)", () => {
  it("contapp_backend en el estudio A no asigna clientes ni usuarios de B, ni escribe filas con tenant_id de B", async () => {
    const a = await ea.estudio();
    const bb = await ea.estudio();
    const uA = await ea.miembro(a.id, "contador");
    const uB = await ea.miembro(bb.id, "contador");
    const cA = await ea.cliente(a.id);
    const cB = await ea.cliente(bb.id);
    const ins = "insert into asignacion (tenant_id, cliente_id, usuario_id, tipo) values ($1, $2, $3, 'colaborador')";
    const casos: [string, unknown[]][] = [
      ["cliente de B", [a.id, cB, uA.id]],
      ["usuario de B", [a.id, cA, uB.id]],
      ["fila de B", [bb.id, cB, uB.id]],
      ["mezcla", [bb.id, cA, uA.id]],
    ];
    const r: Record<string, unknown> = {};
    for (const [n, v] of casos) r[n] = codigo(await intentar(db, { tenantId: a.id }, ins, v)) !== "ok";
    expect(r).toEqual(Object.fromEntries(casos.map(([n]) => [n, true])));
    // Y en A no se ve ni se puede tocar una asignación de B.
    await ea.asignar(bb.id, cB, uB.id, "responsable");
    const upd = await intentar(db, { tenantId: a.id }, "update asignacion set usuario_id = $1 where cliente_id = $2", [uA.id, cB]);
    expect(upd).toEqual({ ok: true, rowCount: 0 });
    const del = await intentar(db, { tenantId: a.id }, "delete from asignacion where cliente_id = $1", [cB]);
    expect(del).toEqual({ ok: true, rowCount: 0 });
  });
});

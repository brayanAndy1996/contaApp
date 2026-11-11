// Spec 012b · T17 ronda adversarial 1 (adversario). Privilegios del worker sobre los estados de los dos libros y
// `archivo_generado` (lección de 016: ningún grant amplio). Caminos que las pruebas de T4 no recorren: el UPDATE escondido en un
// INSERT ... ON CONFLICT DO UPDATE y las vías para apagar o rodear los triggers desde el rol del worker. El paso del worker a
// `contapp_backend` con SET ROLE es el riesgo aceptado D8 de 002 (escalada.adv.spec.ts) y no se vuelve a probar aquí.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirAdmin } from "./auth-soporte";
import { intentar, type ContappDb, type Tx } from "./soporte";
import { codigo, crearDb, type ClientePrueba } from "./trabajos-soporte";
import { EscenarioArchivos, PERIODO, type Libro } from "./archivos-soporte";

let admin: Pool;
let ec: EscenarioArchivos;
let worker: ContappDb;
let X: string;
let ux: string;

beforeAll(async () => {
  admin = abrirAdmin(4);
  ec = new EscenarioArchivos(admin);
  X = (await ec.estudio()).id;
  ux = await ec.usuarioDe(X);
  worker = crearDb("contapp_worker", 2);
});
afterAll(async () => {
  await ec?.limpiar();
  await worker?.close().catch(() => undefined);
  await admin?.end();
});

const TABLAS: [Libro, string][] = [
  ["compras", "compra_periodo"],
  ["ventas", "venta_periodo"],
];
const estadoEn = async (tabla: string, c: ClientePrueba) =>
  (await admin.query(`select estado, marcado_por from ${tabla} where cliente_id = $1 and periodo = $2`, [c.id, PERIODO])).rows;

/** Varias sentencias del worker en UNA transacción (siempre ROLLBACK); devuelve el SQLSTATE de la primera que falla, u 'ok'. */
async function comoWorker(sentencias: [string, unknown[]][]): Promise<string> {
  try {
    await worker.withTenant({ tenantId: X }, async (tx: Tx) => {
      for (const [sql, valores] of sentencias) await tx.query(sql, valores);
      throw Object.assign(new Error("rollback"), { code: "rollback" });
    });
    return "ok";
  } catch (e) {
    const c = String((e as { code?: string }).code ?? "sin_codigo");
    return c === "rollback" ? "ok" : c;
  }
}

describe("ADV-012b-b · el worker no reabre ni revisa por el UPDATE de un INSERT ... ON CONFLICT DO UPDATE", () => {
  it.each(TABLAS)("%s: generado -> abierto y abierto -> revisado por upsert dan 42501 y no cambian nada", async (libro, tabla) => {
    const upsert = (c: ClientePrueba, estado: string, por: string | null) =>
      intentar(
        worker,
        { tenantId: X },
        `insert into ${tabla} (cliente_id, periodo, estado) values ($1, $2, 'abierto')
         on conflict (tenant_id, cliente_id, periodo) do update set estado = $3, marcado_por = $4::uuid,
           marcado_en = case when $4::uuid is null then null else now() end`,
        [c.id, PERIODO, estado, por],
      );
    const g = await ec.cliente(X);
    await ec.periodoDe(libro, X, g, PERIODO, "generado", ux);
    expect(codigo(await upsert(g, "abierto", ux)), "reabrir con marca").toBe("42501");
    expect(codigo(await upsert(g, "abierto", null)), "reabrir sin marca").toBe("42501");
    expect(await estadoEn(tabla, g)).toEqual([{ estado: "generado", marcado_por: ux }]);

    const a = await ec.cliente(X);
    await ec.periodoDe(libro, X, a, PERIODO, "abierto", null);
    expect(codigo(await upsert(a, "revisado", ux)), "revisar").toBe("42501");
    expect(await estadoEn(tabla, a)).toEqual([{ estado: "abierto", marcado_por: null }]);
  });
});

describe("ADV-012b-c · el worker no apaga ni rodea los triggers de 012b", () => {
  it.each(TABLAS)("%s: replica, DISABLE TRIGGER, reemplazar la función o pasar a migrator/platform dan 42501", async (libro, tabla) => {
    const c = await ec.cliente(X);
    await ec.periodoDe(libro, X, c, PERIODO, "generado", ux);
    const reabrir: [string, unknown[]] = [
      `update ${tabla} set estado = 'abierto', marcado_por = null, marcado_en = null where cliente_id = $1 and periodo = $2`,
      [c.id, PERIODO],
    ];
    const intentos: [string, [string, unknown[]][]][] = [
      ["session_replication_role = replica", [["set local session_replication_role = replica", []], reabrir]],
      ["ALTER TABLE ... DISABLE TRIGGER", [[`alter table ${tabla} disable trigger periodo_worker_acotado`, []], reabrir]],
      ["ALTER TABLE archivo_generado DISABLE TRIGGER", [["alter table archivo_generado disable trigger archivo_generado_inmutable", []]]],
      [
        "CREATE OR REPLACE de la función del trigger",
        [
          [
            `create or replace function public.periodo_worker_acotado() returns trigger language plpgsql as $f$ begin return new; end $f$`,
            [],
          ],
          reabrir,
        ],
      ],
      ["SET ROLE contapp_migrator", [["set local role contapp_migrator", []], reabrir]],
      ["SET ROLE contapp_platform", [["set local role contapp_platform", []], reabrir]],
      ["set_config de row_security", [["select set_config('row_security', 'off', true)", []], reabrir]],
    ];
    for (const [nombre, sentencias] of intentos) {
      const r = await comoWorker(sentencias);
      expect(r, nombre).not.toBe("ok");
      expect(["42501", "42883"], `${nombre}: ${r}`).toContain(r);
    }
    expect(await estadoEn(tabla, c)).toEqual([{ estado: "generado", marcado_por: ux }]);
  });
});

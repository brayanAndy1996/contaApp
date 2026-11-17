// Spec 021 · T17: correcciones de la ronda adversarial 1 (rojo) sobre la BD. Una prueba normal por hallazgo, con el comportamiento
// que fija la spec: H-021-1-3 y H-021-1-4 (D-7, CA-4: `aplicar_regla_historial` no crea una versión `historial` que no mueve nada),
// H-021-1-5 (P-1: solo cuenta la fila cuya versión vigente sigue siendo la `historial` aplicada por la regla) y H-021-1-6
// (decisión del usuario, 2026-11-13: la fila «Según historial» excluida no cuenta ni confirma). Fallan hasta T18.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { abrirAdmin, exportado } from "./auth-soporte";
import { enRollback, type ContappDb, type Tx } from "./soporte";
import { crearDb, type ClientePrueba } from "./trabajos-soporte";
import {
  aplicar,
  compraDelWorker,
  consolidar,
  datosJson,
  DESCARGA,
  EscenarioReglas,
  FACTURA_DG,
  montos,
  type Destino,
  type Montos,
} from "./reglas-soporte";

let admin: Pool;
let ec: EscenarioReglas;
let worker: ContappDb;
let backend: ContappDb;
let X: string;
let ux: string;
let errSiembra: unknown;

beforeAll(async () => {
  admin = abrirAdmin(4);
  ec = new EscenarioReglas(admin);
  try {
    X = (await ec.estudio()).id;
    ux = await ec.usuarioDe(X);
  } catch (e) {
    errSiembra = e;
  }
  worker = crearDb("contapp_worker", 3);
  backend = crearDb("contapp_backend", 3);
});
beforeEach(() => {
  if (errSiembra) throw errSiembra;
});
afterAll(async () => {
  await ec?.limpiar();
  await Promise.all([worker?.close(), backend?.close(), ec?.cerrar()].map((p) => p?.catch(() => undefined)));
  await admin?.end();
});

let consecutivo = 0;
const doc = () => `20${String(820000000 + ++consecutivo)}`;
const num = () => String(9300 + ++consecutivo);

/** SQLSTATE de una sentencia dentro de un SAVEPOINT (o 'ok'), sin abortar la transacción. */
async function estado(tx: Tx, sql: string, valores: unknown[]): Promise<string> {
  await tx.query("SAVEPOINT adv");
  try {
    await tx.query(sql, valores);
    await tx.query("RELEASE SAVEPOINT adv");
    return "ok";
  } catch (e) {
    await tx.query("ROLLBACK TO SAVEPOINT adv");
    return String((e as { code?: string }).code ?? "sin_codigo");
  }
}
const SQL_APLICAR = "select public.aplicar_regla_historial($1, $2, $3::jsonb)";

// ===================================================================================================================
// aplicar_regla_historial (D-7, CA-4)
// ===================================================================================================================

describe("aplicar_regla_historial: rechaza lo que no mueve nada o no se clasifica (D-7, CA-4)", () => {
  /** Compra nueva con la versión 1 `m` y regla DNG; intenta aplicar la consolidación exacta en DNG. */
  async function intentar(m: Montos): Promise<{ sqlstate: string; versiones: number }> {
    const c = await ec.cliente(X);
    const prop = await ec.propuesta(X, c, { libro: "compras", periodo: DESCARGA, nuevas: 5 });
    const d = doc();
    const regla = await ec.regla(X, c, { docNumero: d, destino: "DNG" });
    return enRollback(worker, { tenantId: X }, async (tx) => {
      const compra = await compraDelWorker(tx, c.id, prop, DESCARGA, { numero: num(), docNumero: d, montos: m });
      const sqlstate = await estado(tx, SQL_APLICAR, [compra, regla, JSON.stringify(datosJson(consolidar(m, "DNG")))]);
      const n = await tx.query("select count(*)::int as n from compra_version where compra_id = $1", [compra]);
      return { sqlstate, versiones: (n.rows[0] as { n: number }).n };
    });
  }

  it("H-021-1-3 · fila con base gravada 0 (solo no gravado): se rechaza con 42501 y no se crea versión (CA-4)", async () => {
    expect(await intentar(montos({ noGravado: "500.00" }))).toEqual({ sqlstate: "42501", versiones: 1 });
  });

  it("H-021-1-4 · la versión 1 ya está en el destino de la regla: se rechaza con 42501 y no se crea versión (D-7)", async () => {
    expect(await intentar(montos({ biDng: "1000.00", igvDng: "180.00" }))).toEqual({ sqlstate: "42501", versiones: 1 });
  });
});

// ===================================================================================================================
// regla_aceptar_periodo (P-1, P-4, D-3)
// ===================================================================================================================

const fijarEstadoPeriodo = (tx: Tx, clienteId: string, periodo: string, desde: string, hacia: string, usuarioId: string) =>
  exportado<(tx: Tx, c: string, p: string, d: string, h: string, u: string) => Promise<unknown>>("fijarEstadoPeriodo")(
    tx,
    clienteId,
    periodo,
    desde,
    hacia,
    usuarioId,
  );

interface Escenario {
  c: ClientePrueba;
  regla: string;
  compras: string[];
}

/** Cliente con una regla y `n` compras de 202610 con versión 2 `historial` (por la función real de 0048), periodo abierto. */
async function escenario(n: number, destino: Destino = "DNG"): Promise<Escenario> {
  const c = await ec.cliente(X);
  const prop = await ec.propuesta(X, c, { libro: "compras", periodo: DESCARGA, nuevas: 10 });
  const d = doc();
  const regla = await ec.regla(X, c, { docNumero: d, destino });
  await ec.estadoPeriodo(X, c, DESCARGA, "abierto", null);
  const compras = await worker.withTenant({ tenantId: X }, async (tx) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = await compraDelWorker(tx, c.id, prop, DESCARGA, { serie: "F89", numero: num(), docNumero: d });
      await aplicar(tx, id, regla, consolidar(FACTURA_DG, destino));
      ids.push(id);
    }
    return ids;
  });
  return { c, regla, compras };
}
const revisar = (e: Escenario) =>
  backend.withTenant({ tenantId: X, userId: ux }, (tx) => fijarEstadoPeriodo(tx, e.c.id, DESCARGA, "abierto", "revisado", ux));
const aceptadas = async (regla: string): Promise<string[]> =>
  (
    await admin.query(
      `select p.compra_id from regla_aceptacion a join regla_aplicacion p on p.id = a.regla_aplicacion_id
        where a.regla_id = $1 order by p.compra_id`,
      [regla],
    )
  ).rows.map((r) => r.compra_id as string);
const confirmacionesAceptadas = async (regla: string): Promise<{ destino: string }[]> =>
  (await admin.query("select destino from regla_confirmacion where regla_id = $1 and origen = 'aceptada'", [regla])).rows;

describe("regla_aceptar_periodo: qué cuenta como aceptada (P-1, P-4, D-3)", () => {
  it("H-021-1-5 · regla editada DNG → DG tras la descarga y fila movida a DG a mano: no cuenta como aceptada ni deja confirmación", async () => {
    const e = await escenario(2);
    await admin.query("update regla_aprendida set destino = 'DG', version = version + 1 where id = $1", [e.regla]);
    await ec.version(X, e.compras[0]!, 3, { accion: "editar", usuarioId: ux, montos: consolidar(FACTURA_DG, "DG") });
    await revisar(e);
    expect(await aceptadas(e.regla)).not.toContain(e.compras[0]);
    expect(await confirmacionesAceptadas(e.regla)).toEqual([]);
  });

  it("H-021-1-6 · fila «Según historial» que el contador excluyó después: no cuenta como aceptada ni deja confirmación", async () => {
    const e = await escenario(1);
    await ec.version(X, e.compras[0]!, 3, { accion: "excluir", excluida: true, motivo: "no corresponde", usuarioId: ux });
    await revisar(e);
    expect(await aceptadas(e.regla)).toEqual([]);
    expect(await confirmacionesAceptadas(e.regla)).toEqual([]);
  });
});

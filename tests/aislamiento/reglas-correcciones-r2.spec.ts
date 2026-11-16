// Spec 021 · T20: correcciones de la ronda adversarial 2 (rojo) sobre la BD. Una prueba normal por hallazgo con el comportamiento
// que fija la spec (decisión del usuario, 2026-11-13): H-021-2-1, una fila «Según historial» que el contador dejó sin base gravada
// en ningún destino no cuenta como aceptada al pasar a `revisado` ni deja confirmación (`regla_aceptar_periodo`, 0050). Falla
// hasta T21.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { abrirAdmin, exportado } from "./auth-soporte";
import type { ContappDb, Tx } from "./soporte";
import { crearDb, type ClientePrueba } from "./trabajos-soporte";
import {
  aplicar,
  compraDelWorker,
  consolidar,
  DESCARGA,
  EscenarioReglas,
  FACTURA_DG,
  montos,
  type Destino,
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
  await Promise.all(
    [worker?.close(), backend?.close(), ec?.cerrar()].map((p) =>
      p?.catch(() => undefined),
    ),
  );
  await admin?.end();
});

let consecutivo = 0;
const doc = () => `20${String(820000000 + ++consecutivo)}`;
const num = () => String(9300 + ++consecutivo);

const fijarEstadoPeriodo = (
  tx: Tx,
  clienteId: string,
  periodo: string,
  desde: string,
  hacia: string,
  usuarioId: string,
) =>
  exportado<
    (
      tx: Tx,
      c: string,
      p: string,
      d: string,
      h: string,
      u: string,
    ) => Promise<unknown>
  >("fijarEstadoPeriodo")(tx, clienteId, periodo, desde, hacia, usuarioId);

interface Escenario {
  c: ClientePrueba;
  regla: string;
  compras: string[];
}

/** Cliente con una regla y `n` compras de 202610 con versión 2 `historial` (por la función real de 0048), periodo abierto. */
async function escenario(
  n: number,
  destino: Destino = "DNG",
): Promise<Escenario> {
  const c = await ec.cliente(X);
  const prop = await ec.propuesta(X, c, {
    libro: "compras",
    periodo: DESCARGA,
    nuevas: 10,
  });
  const d = doc();
  const regla = await ec.regla(X, c, { docNumero: d, destino });
  await ec.estadoPeriodo(X, c, DESCARGA, "abierto", null);
  const compras = await worker.withTenant({ tenantId: X }, async (tx) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = await compraDelWorker(tx, c.id, prop, DESCARGA, {
        serie: "F89",
        numero: num(),
        docNumero: d,
      });
      await aplicar(tx, id, regla, consolidar(FACTURA_DG, destino));
      ids.push(id);
    }
    return ids;
  });
  return { c, regla, compras };
}
const revisar = (e: Escenario) =>
  backend.withTenant({ tenantId: X, userId: ux }, (tx) =>
    fijarEstadoPeriodo(tx, e.c.id, DESCARGA, "abierto", "revisado", ux),
  );
const aceptadas = async (regla: string): Promise<string[]> =>
  (
    await admin.query(
      `select p.compra_id from regla_aceptacion a join regla_aplicacion p on p.id = a.regla_aplicacion_id
        where a.regla_id = $1 order by p.compra_id`,
      [regla],
    )
  ).rows.map((r) => r.compra_id as string);
const confirmacionesAceptadas = async (
  regla: string,
): Promise<{ destino: string }[]> =>
  (
    await admin.query(
      "select destino from regla_confirmacion where regla_id = $1 and origen = 'aceptada'",
      [regla],
    )
  ).rows;

describe("regla_aceptar_periodo: la fila sin base gravada no cuenta (P-1, P-4, D-3)", () => {
  it("H-021-2-1 · fila «Según historial» que el contador dejó sin base gravada (todo a no gravado): no cuenta como aceptada ni deja confirmación", async () => {
    const e = await escenario(1);
    await ec.version(X, e.compras[0]!, 3, {
      accion: "editar",
      usuarioId: ux,
      montos: montos({ noGravado: "1180.00" }),
    });
    await revisar(e);
    expect(await aceptadas(e.regla)).toEqual([]);
    expect(await confirmacionesAceptadas(e.regla)).toEqual([]);
  });
});

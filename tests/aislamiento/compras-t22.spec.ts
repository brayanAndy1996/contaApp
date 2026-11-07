// Spec 014 T22a · `aplicarMasiva` con `descartarAgregadas: true` contra la BD real (D-7, D-15, DU-16, H-014-1; T22, H-014-1 en
// `operaciones.ts`). Esa rama solo la ejercían las suites del backend, así que `cobertura:db` no la veía. Se prueba en `packages/db`:
//  - mezcla de agregadas y del SIRE con ids intercalados: las agregadas quedan con `descartada_en` y SIN versión nueva; las del
//    SIRE reciben su versión nueva, todas con el mismo `operacion_id`, en UNA sola operación;
//  - una agregada con `versionBase` vieja sale `version_obsoleta` y NO se descarta;
//  - sin la bandera, una agregada recibe `transformar` como cualquier fila (la bandera es explícita);
//  - solo agregadas: se descartan, `operacionId` es null y no se crea operación;
//  - las agregadas no entran en deshacer: deshacer revierte las del SIRE y las agregadas siguen descartadas, y con solo agregadas
//    no hay nada que deshacer;
//  - una agregada de otro cliente o de otro estudio sale `no_encontrada` y no se descarta.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirAdmin, exportado } from "./auth-soporte";
import type { ContappDb, Tx } from "./soporte";
import { crearDb, type ClientePrueba } from "./trabajos-soporte";
import {
  codigoDe,
  contarFilas,
  EscenarioCompras,
  PERIODO,
  sinHallazgos,
  transformarFalso,
  type ParametrosFalsos,
} from "./compras-soporte";

interface Resultado {
  operacionId: string | null;
  aplicadas: number;
  rechazadas: { compraId: string; codigo: string }[];
}
const aplicarMasiva = (tx: Tx, e: unknown, f: unknown) =>
  exportado<(tx: Tx, e: unknown, f: unknown) => Promise<Resultado>>("aplicarMasiva")(tx, e, f);
const deshacer = (tx: Tx, e: unknown, f: unknown) =>
  exportado<(tx: Tx, e: unknown, f: unknown) => Promise<{ operacionId: string; filas: number }>>("deshacer")(tx, e, f);

let admin: Pool;
let ec: EscenarioCompras;
let backend: ContappDb;
let X: string;
let Y: string;
let cx: ClientePrueba;
let cy: ClientePrueba;
let ux: string;
let propX: string;

beforeAll(async () => {
  admin = abrirAdmin(6);
  ec = new EscenarioCompras(admin);
  X = (await ec.estudio()).id;
  Y = (await ec.estudio()).id;
  cx = await ec.cliente(X);
  cy = await ec.cliente(Y);
  ux = await ec.usuarioDe(X);
  backend = crearDb("contapp_backend", 8);
  propX = await ec.propuesta(X, cx, { libro: "compras", nuevas: 1 });
});
afterAll(async () => {
  await ec?.limpiar();
  await backend?.close().catch(() => undefined);
  await admin?.end();
});

const EXCLUIR: ParametrosFalsos = { tipo: "excluir", motivo: "zapatillas" };
const funciones = () => ({ transformar: transformarFalso, evaluar: sinHallazgos().evaluar });
const items = (cs: { id: string }[], base = 1) => cs.map((c) => ({ compraId: c.id, versionBase: base }));
const masiva = (c: ClientePrueba, its: { compraId: string; versionBase: number }[], descartarAgregadas?: boolean, parametros = EXCLUIR) =>
  backend.withTenant({ tenantId: X }, (tx) =>
    aplicarMasiva(
      tx,
      { clienteId: c.id, periodo: PERIODO, usuarioId: ux, accion: "excluir", parametros, items: its, descartarAgregadas },
      funciones(),
    ),
  );
const pila = (c: ClientePrueba) => ({ clienteId: c.id, periodo: PERIODO, usuarioId: ux });
const versionesDe = async (id: string) =>
  (await admin.query("select * from compra_version where compra_id = $1 order by n", [id])).rows;
const estaDescartada = async (id: string): Promise<boolean> =>
  (await admin.query("select descartada_en is not null as d from compra where id = $1", [id])).rows[0].d as boolean;
const operaciones = (c: ClientePrueba) => contarFilas(admin, "compra_operacion", "cliente_id = $1", [c.id]);

/** Siembra A1, S1, A2, S2, A3, S3 en ese orden: los ids (UUID v7) quedan intercalados entre agregadas y del SIRE. */
async function intercaladas(c: ClientePrueba, prefijo: string) {
  const agregadas: { id: string }[] = [];
  const sire: { id: string }[] = [];
  for (let i = 1; i <= 3; i++) {
    agregadas.push(await ec.compra(X, c, { origen: "agregada", serie: `${prefijo}A`, numero: String(i) }));
    sire.push(await ec.compra(X, c, { origen: "sire", serie: `${prefijo}S`, numero: String(i), propuestaId: propX }));
  }
  return { agregadas, sire };
}

describe("aplicarMasiva con descartarAgregadas (D-7, DU-16)", () => {
  it("mezcla intercalada: las agregadas se descartan sin versión nueva y las del SIRE reciben su versión en UNA operación", async () => {
    const c = await ec.cliente(X);
    const { agregadas, sire } = await intercaladas(c, "TA");
    const todas = [...agregadas, ...sire];
    const antes = await operaciones(c);

    // Se pide en orden revuelto: el orden de bloqueo lo decide el id, no la petición.
    const r = await masiva(c, items([sire[2]!, agregadas[0]!, sire[0]!, agregadas[2]!, agregadas[1]!, sire[1]!]), true);

    expect(r.rechazadas).toEqual([]);
    expect(r.aplicadas).toBe(6);
    expect(r.operacionId).not.toBeNull();
    expect(await operaciones(c)).toBe(antes + 1);
    for (const a of agregadas) {
      expect(await estaDescartada(a.id), `agregada ${a.id}`).toBe(true);
      expect((await versionesDe(a.id)).map((x) => x.n)).toEqual([1]);
    }
    for (const s of sire) {
      expect(await estaDescartada(s.id)).toBe(false);
      const vs = await versionesDe(s.id);
      expect(vs.map((x) => x.n)).toEqual([1, 2]);
      expect(vs[1]).toMatchObject({ accion: "excluir", excluida: true, motivo: "zapatillas", operacion_id: r.operacionId, usuario_id: ux });
    }
    expect(await contarFilas(admin, "compra_version", "operacion_id = $1", [r.operacionId])).toBe(3);
    expect(await contarFilas(admin, "compra_version", "compra_id = any($1::uuid[])", [todas.map((t) => t.id)])).toBe(9);
  });

  it("una agregada con versionBase vieja sale version_obsoleta y NO se descarta; las demás sí", async () => {
    const c = await ec.cliente(X);
    const { agregadas, sire } = await intercaladas(c, "TB");
    await ec.version(X, agregadas[1]!.id, 2, { montos: { biDg: "55.00" } });

    const r = await masiva(c, items([...agregadas, ...sire], 1), true);

    expect(r.rechazadas).toEqual([{ compraId: agregadas[1]!.id, codigo: "version_obsoleta" }]);
    expect(r.aplicadas).toBe(5);
    expect(await estaDescartada(agregadas[1]!.id)).toBe(false);
    expect((await versionesDe(agregadas[1]!.id)).map((x) => x.n)).toEqual([1, 2]);
    expect(await estaDescartada(agregadas[0]!.id)).toBe(true);
    expect(await estaDescartada(agregadas[2]!.id)).toBe(true);
    expect((await versionesDe(sire[0]!.id)).map((x) => x.n)).toEqual([1, 2]);
  });

  it("sin la bandera, una agregada recibe transformar como cualquier fila: versión nueva y sin descartar", async () => {
    const c = await ec.cliente(X);
    const { agregadas, sire } = await intercaladas(c, "TC");

    const r = await masiva(c, items([agregadas[0]!, sire[0]!]));

    expect(r.aplicadas).toBe(2);
    expect(await estaDescartada(agregadas[0]!.id)).toBe(false);
    expect((await versionesDe(agregadas[0]!.id)).map((x) => x.n)).toEqual([1, 2]);
    expect((await versionesDe(sire[0]!.id)).map((x) => x.n)).toEqual([1, 2]);
  });

  it("solo agregadas: se descartan, operacionId es null y no se crea operación ni versión", async () => {
    const c = await ec.cliente(X);
    const { agregadas } = await intercaladas(c, "TD");
    const antes = await operaciones(c);

    const r = await masiva(c, items(agregadas), true);

    expect(r).toEqual({ operacionId: null, aplicadas: 3, rechazadas: [] });
    expect(await operaciones(c)).toBe(antes);
    for (const a of agregadas) {
      expect(await estaDescartada(a.id)).toBe(true);
      expect((await versionesDe(a.id)).map((x) => x.n)).toEqual([1]);
    }
  });

  it("solo agregadas con versión obsoleta: nada se aplica, nada se descarta y operacionId es null", async () => {
    const c = await ec.cliente(X);
    const a = await ec.compra(X, c, { origen: "agregada", serie: "TE", numero: "1" });
    await ec.version(X, a.id, 2, { montos: { biDg: "7.00" } });

    const r = await masiva(c, items([a], 1), true);

    expect(r).toEqual({ operacionId: null, aplicadas: 0, rechazadas: [{ compraId: a.id, codigo: "version_obsoleta" }] });
    expect(await estaDescartada(a.id)).toBe(false);
  });

  it("una agregada de otro cliente o de otro estudio sale no_encontrada y no se descarta", async () => {
    const c = await ec.cliente(X);
    const propia = await ec.compra(X, c, { origen: "agregada", serie: "TF", numero: "1" });
    const deOtroCliente = await ec.compra(X, cx, { origen: "agregada", serie: "TF", numero: "2" });
    const deOtroEstudio = await ec.compra(Y, cy, { origen: "agregada", serie: "TF", numero: "3" });

    const r = await masiva(c, items([propia, deOtroCliente, deOtroEstudio]), true);

    expect(r.aplicadas).toBe(1);
    expect(r.rechazadas.map((x) => x.compraId).sort()).toEqual([deOtroCliente.id, deOtroEstudio.id].sort());
    expect(r.rechazadas.every((x) => x.codigo === "no_encontrada")).toBe(true);
    expect(await estaDescartada(propia.id)).toBe(true);
    expect(await estaDescartada(deOtroCliente.id)).toBe(false);
    expect(await estaDescartada(deOtroEstudio.id)).toBe(false);
  });
});

describe("las agregadas descartadas por una masiva no entran en deshacer (DU-14, DU-16)", () => {
  it("deshacer revierte solo las del SIRE (filas = 3); las agregadas siguen descartadas y sin versión nueva", async () => {
    const c = await ec.cliente(X);
    const { agregadas, sire } = await intercaladas(c, "TG");
    const r = await masiva(c, items([...agregadas, ...sire]), true);
    expect(r.aplicadas).toBe(6);

    const h = await backend.withTenant({ tenantId: X }, (tx) => deshacer(tx, pila(c), funciones()));

    expect(h.filas).toBe(3);
    for (const a of agregadas) {
      expect(await estaDescartada(a.id)).toBe(true);
      expect((await versionesDe(a.id)).map((x) => x.n)).toEqual([1]);
    }
    for (const s of sire) {
      const vs = await versionesDe(s.id);
      expect(vs.map((x) => x.n)).toEqual([1, 2, 3]);
      expect(vs[2]).toMatchObject({ accion: "deshacer", excluida: false, operacion_id: h.operacionId });
    }
  });

  it("si la masiva fue solo de agregadas no hay operación y deshacer responde nada_que_deshacer", async () => {
    const c = await ec.cliente(X);
    const { agregadas } = await intercaladas(c, "TH");
    await masiva(c, items(agregadas), true);

    const codigo = await codigoDe(backend.withTenant({ tenantId: X }, (tx) => deshacer(tx, pila(c), funciones())));

    expect(codigo).toBe("nada_que_deshacer");
    for (const a of agregadas) expect(await estaDescartada(a.id)).toBe(true);
  });
});

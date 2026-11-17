// Spec 021 (T3, rojo): repositorio `packages/db/src/reglas/` contra la BD real y la auditoria que dejan sus escrituras. Cubre D-2,
// D-3, D-5, P-1, P-2, P-5, P-9, P-10, CA-5, CA-6, CA-7, CA-9 y CA-13: `recordarRegla` (crea, actualiza con version, 409 con version
// vieja, reactiva una inactiva, confirmacion `recordar`), `editarRegla`, `eliminarRegla`, `listarReglas`, interruptores del motor, y
// las acciones de auditoria `regla.*`, `estudio.*` y el CHECK ampliado. Contrato en el encabezado de `reglas-soporte.ts`.
// Hasta T9 fallan: `@contapp/db` aun no exporta estas funciones y las tablas no existen.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { abrirAdmin, exportado } from "./auth-soporte";
import { type ContappDb, type Tx } from "./soporte";
import { codigoDe } from "./compras-soporte";
import { crearDb, type ClientePrueba } from "./trabajos-soporte";
import { enRevertida, uuidAjeno, type FilaAud } from "./auditoria-soporte";
import {
  APRENDIDO,
  DESCARGA,
  EscenarioReglas,
  type Destino,
} from "./reglas-soporte";

let admin: Pool;
let ec: EscenarioReglas;
let backend: ContappDb;
let X: string;
let Y: string;
let W: string; // aporte apagado
let cx: ClientePrueba;
let cx2: ClientePrueba;
let cy: ClientePrueba;
let cw: ClientePrueba;
let ux: string;
let uy: string;
let uw: string;
let propX: string;
let propX2: string;
let propY: string;
let propW: string;
let errSiembra: unknown;

beforeAll(async () => {
  admin = abrirAdmin(8);
  ec = new EscenarioReglas(admin);
  X = (await ec.estudio()).id;
  Y = (await ec.estudio()).id;
  W = (await ec.estudio()).id;
  cx = await ec.cliente(X);
  cx2 = await ec.cliente(X);
  cy = await ec.cliente(Y);
  cw = await ec.cliente(W);
  ux = await ec.usuarioDe(X);
  uy = await ec.usuarioDe(Y);
  uw = await ec.usuarioDe(W);
  backend = crearDb("contapp_backend", 4);
  propX = await ec.propuesta(X, cx, { libro: "compras", periodo: DESCARGA, nuevas: 50 });
  propX2 = await ec.propuesta(X, cx2, { libro: "compras", periodo: DESCARGA, nuevas: 50 });
  propY = await ec.propuesta(Y, cy, { libro: "compras", periodo: DESCARGA, nuevas: 50 });
  propW = await ec.propuesta(W, cw, { libro: "compras", periodo: DESCARGA, nuevas: 50 });
  try {
    await ec.aporte(W, false);
  } catch (e) {
    errSiembra = e; // 0047 aun no existe: cada prueba falla por esa razon, no el bloque entero
  }
});
beforeEach(() => {
  if (errSiembra) throw errSiembra;
});
afterAll(async () => {
  await ec?.limpiar();
  await Promise.all(
    [backend?.close(), ec?.cerrar()].map((p) => p?.catch(() => undefined)),
  );
  await admin?.end();
});

interface ReglaFila {
  id: string;
  clienteId: string;
  docTipo: string;
  docNumero: string;
  destino: Destino;
  activa: boolean;
  version: number;
  periodoAprendido: string;
  creadaPor: string;
  razonSocial?: string | null;
  aplicada?: number;
  aceptada?: number;
}
type Codigo = "regla_cambiada" | "proveedores_distintos" | "no_encontrada";

const comoX = <T>(fn: (tx: Tx) => Promise<T>) => backend.withTenant({ tenantId: X, userId: ux }, fn);
const repo = {
  listar: (tx: Tx, clienteId: string) =>
    exportado<(tx: Tx, c: string) => Promise<ReglaFila[]>>("listarReglas")(tx, clienteId),
  recordar: (
    tx: Tx,
    e: { clienteId: string; compraIds: string[]; destino: Destino; versionBase: number | null; usuarioId: string },
  ) => exportado<(tx: Tx, e: unknown) => Promise<ReglaFila | Codigo>>("recordarRegla")(tx, e),
  editar: (
    tx: Tx,
    e: { clienteId: string; reglaId: string; versionBase: number; destino?: Destino; activa?: boolean; usuarioId: string },
  ) => exportado<(tx: Tx, e: unknown) => Promise<ReglaFila | Codigo>>("editarRegla")(tx, e),
  eliminar: (tx: Tx, e: { clienteId: string; reglaId: string; versionBase: number; usuarioId: string }) =>
    exportado<(tx: Tx, e: unknown) => Promise<"ok" | Codigo>>("eliminarRegla")(tx, e),
  leerMotor: (tx: Tx) =>
    exportado<(tx: Tx) => Promise<{ filas: { codigo: string; activa: boolean }[]; aportarCatalogo: boolean }>>(
      "leerReglasMotor",
    )(tx),
  fijarMotor: (tx: Tx, e: { codigo: string; activa: boolean; usuarioId: string }) =>
    exportado<(tx: Tx, e: unknown) => Promise<void>>("fijarReglaMotor")(tx, e),
  fijarAporte: (tx: Tx, e: { aportar: boolean; usuarioId: string }) =>
    exportado<(tx: Tx, e: unknown) => Promise<void>>("fijarAporte")(tx, e),
};

let consecutivo = 0;
const docNuevo = () => `20${String(700000000 + ++consecutivo)}`;

/** Compra sembrada (version 1 `original`) de un proveedor, en el cliente y periodo dados. */
const compra = (
  tenant: string,
  c: ClientePrueba,
  prop: string,
  docNumero: string,
  o: { periodo?: string; docTipo?: string; razonSocial?: string | null; fecha?: string } = {},
) =>
  ec
    .compra(tenant, c, {
      periodo: o.periodo ?? DESCARGA,
      propuestaId: prop,
      docNumero,
      docTipo: o.docTipo ?? "6",
      razonSocial: o.razonSocial,
      fecha: o.fecha,
    })
    .then((x) => x.id);

const reglaDe = async (id: string) =>
  (await admin.query("select * from regla_aprendida where id = $1", [id])).rows[0];
const confirmaciones = async (regla: string) =>
  (
    await admin.query(
      "select cliente_id, ruc_proveedor, destino, origen from regla_confirmacion where regla_id = $1 order by creada_en, id",
      [regla],
    )
  ).rows;
const versiones = async (clienteId: string) =>
  (
    await admin.query(
      "select count(*)::int as n from compra_version v join compra c on c.id = v.compra_id where c.cliente_id = $1",
      [clienteId],
    )
  ).rows[0].n as number;

// =================================================================================================
describe("recordarRegla (D-2, D-5, P-1, P-2, P-5, P-10)", () => {
  it("versionBase null crea la regla: destino, version 1, periodo_aprendido = periodo de las compras, autor; no toca ninguna compra (D-5)", async () => {
    const doc = docNuevo();
    const [a, b] = [await compra(X, cx, propX, doc), await compra(X, cx, propX, doc)];
    const antes = await versiones(cx.id);
    const r = await comoX((tx) =>
      repo.recordar(tx, { clienteId: cx.id, compraIds: [a, b], destino: "DNG", versionBase: null, usuarioId: ux }),
    );
    expect(r).toMatchObject({
      clienteId: cx.id,
      docTipo: "6",
      docNumero: doc,
      destino: "DNG",
      activa: true,
      version: 1,
      periodoAprendido: DESCARGA,
      creadaPor: ux,
    });
    const fila = await reglaDe((r as ReglaFila).id);
    expect(fila).toMatchObject({ destino: "DNG", activa: true, version: 1, periodo_aprendido: DESCARGA, eliminada_en: null });
    expect(await versiones(cx.id), "no crea versiones de compras").toBe(antes);
    expect(
      (await admin.query("select version_vigente from compra where id = any($1::uuid[])", [[a, b]])).rows.map((x) => x.version_vigente),
    ).toEqual([1, 1]);
    expect((await admin.query("select count(*)::int as n from regla_aplicacion where regla_id = $1", [fila.id])).rows[0].n).toBe(0);
  });

  it("registra la confirmacion `recordar` en la misma transaccion (RUC 20, aporte encendido): RUC del proveedor, cliente y destino", async () => {
    const doc = docNuevo();
    const a = await compra(X, cx, propX, doc);
    const r = (await comoX((tx) =>
      repo.recordar(tx, { clienteId: cx.id, compraIds: [a], destino: "DGNG", versionBase: null, usuarioId: ux }),
    )) as ReglaFila;
    expect(await confirmaciones(r.id)).toEqual([
      { cliente_id: cx.id, ruc_proveedor: doc, destino: "DGNG", origen: "recordar" },
    ]);
  });

  it("no registra confirmacion con RUC 10, con documento que no es RUC ni con el aporte apagado (P-10, CA-6)", async () => {
    const casos: [string, () => Promise<ReglaFila>][] = [
      [
        "RUC 10",
        async () => {
          const a = await compra(X, cx, propX, "10812345678");
          return (await comoX((tx) =>
            repo.recordar(tx, { clienteId: cx.id, compraIds: [a], destino: "DNG", versionBase: null, usuarioId: ux }),
          )) as ReglaFila;
        },
      ],
      [
        "DNI (tipo 1) con numero que empieza en 20",
        async () => {
          const a = await compra(X, cx, propX, "20123456", { docTipo: "1" });
          return (await comoX((tx) =>
            repo.recordar(tx, { clienteId: cx.id, compraIds: [a], destino: "DNG", versionBase: null, usuarioId: ux }),
          )) as ReglaFila;
        },
      ],
      [
        "aporte apagado",
        async () => {
          const a = await compra(W, cw, propW, docNuevo());
          return (await backend.withTenant({ tenantId: W, userId: uw }, (tx) =>
            repo.recordar(tx, { clienteId: cw.id, compraIds: [a], destino: "DNG", versionBase: null, usuarioId: uw }),
          )) as ReglaFila;
        },
      ],
    ];
    for (const [nombre, hacer] of casos) {
      const r = await hacer();
      expect(r.id, `${nombre}: la regla se crea`).toBeDefined();
      expect(await confirmaciones(r.id), nombre).toEqual([]);
    }
  });

  it("con version actualiza el destino (version + 1) y fija periodo_aprendido al periodo de las compras de esta vez (P-5); otra confirmacion `recordar`", async () => {
    const doc = docNuevo();
    const a = await compra(X, cx, propX, doc, { periodo: APRENDIDO });
    const r1 = (await comoX((tx) =>
      repo.recordar(tx, { clienteId: cx.id, compraIds: [a], destino: "DNG", versionBase: null, usuarioId: ux }),
    )) as ReglaFila;
    expect(r1.periodoAprendido).toBe(APRENDIDO);
    const b = await compra(X, cx, propX, doc, { periodo: DESCARGA });
    const r2 = (await comoX((tx) =>
      repo.recordar(tx, { clienteId: cx.id, compraIds: [b], destino: "DG", versionBase: 1, usuarioId: ux }),
    )) as ReglaFila;
    expect(r2).toMatchObject({ id: r1.id, destino: "DG", version: 2, activa: true, periodoAprendido: DESCARGA });
    expect((await admin.query("select count(*)::int as n from regla_aprendida where cliente_id = $1 and doc_numero = $2", [cx.id, doc])).rows[0].n).toBe(1);
    expect((await confirmaciones(r1.id)).map((c) => [c.destino, c.origen])).toEqual([
      ["DNG", "recordar"],
      ["DG", "recordar"],
    ]);
  });

  it("version vieja: 'regla_cambiada' y no cambia nada (409, CA-9)", async () => {
    const doc = docNuevo();
    const a = await compra(X, cx, propX, doc);
    const r1 = (await comoX((tx) =>
      repo.recordar(tx, { clienteId: cx.id, compraIds: [a], destino: "DNG", versionBase: null, usuarioId: ux }),
    )) as ReglaFila;
    await comoX((tx) =>
      repo.recordar(tx, { clienteId: cx.id, compraIds: [a], destino: "DG", versionBase: 1, usuarioId: ux }),
    );
    const vieja = await comoX((tx) =>
      repo.recordar(tx, { clienteId: cx.id, compraIds: [a], destino: "DGNG", versionBase: 1, usuarioId: ux }),
    );
    expect(vieja).toBe("regla_cambiada");
    expect(await reglaDe(r1.id)).toMatchObject({ destino: "DG", version: 2 });
    expect(await confirmaciones(r1.id), "la fallida no confirma").toHaveLength(2);
  });

  it("versionBase null con una regla viva del proveedor: 'regla_cambiada' (otra persona la creo antes)", async () => {
    const doc = docNuevo();
    const a = await compra(X, cx, propX, doc);
    await ec.regla(X, cx, { docNumero: doc });
    const r = await comoX((tx) =>
      repo.recordar(tx, { clienteId: cx.id, compraIds: [a], destino: "DG", versionBase: null, usuarioId: ux }),
    );
    expect(r).toBe("regla_cambiada");
    expect((await admin.query("select count(*)::int as n from regla_aprendida where cliente_id = $1 and doc_numero = $2", [cx.id, doc])).rows[0].n).toBe(1);
  });

  it("reactiva una regla inactiva con el destino nuevo (version + 1)", async () => {
    const doc = docNuevo();
    const id = await ec.regla(X, cx, { docNumero: doc, activa: false, destino: "DNG" });
    const a = await compra(X, cx, propX, doc);
    const r = await comoX((tx) =>
      repo.recordar(tx, { clienteId: cx.id, compraIds: [a], destino: "DGNG", versionBase: 1, usuarioId: ux }),
    );
    expect(r).toMatchObject({ id, activa: true, destino: "DGNG", version: 2 });
  });

  it("tras eliminar la regla se puede volver a recordar con versionBase null (baja logica, P-9)", async () => {
    const doc = docNuevo();
    await ec.regla(X, cx, { docNumero: doc, eliminada: true });
    const a = await compra(X, cx, propX, doc);
    const r = await comoX((tx) =>
      repo.recordar(tx, { clienteId: cx.id, compraIds: [a], destino: "DNG", versionBase: null, usuarioId: ux }),
    );
    expect(r).toMatchObject({ destino: "DNG", version: 1, activa: true });
  });

  it("proveedores distintos: 'proveedores_distintos' (P-2) y no se crea ninguna regla ni confirmacion", async () => {
    const d1 = docNuevo();
    const d2 = docNuevo();
    const [a, b] = [await compra(X, cx, propX, d1), await compra(X, cx, propX, d2)];
    const antes = (await admin.query("select count(*)::int as n from regla_aprendida where cliente_id = $1", [cx.id])).rows[0].n;
    const r = await comoX((tx) =>
      repo.recordar(tx, { clienteId: cx.id, compraIds: [a, b], destino: "DNG", versionBase: null, usuarioId: ux }),
    );
    expect(r).toBe("proveedores_distintos");
    expect((await admin.query("select count(*)::int as n from regla_aprendida where cliente_id = $1", [cx.id])).rows[0].n).toBe(antes);
  });

  it("'no_encontrada' si alguna compra es de otro cliente, de otro estudio, esta descartada o no existe (404 identico, CA-5)", async () => {
    const doc = docNuevo();
    const propia = await compra(X, cx, propX, doc);
    const deOtroCliente = await compra(X, cx2, propX2, doc);
    const deOtroEstudio = await compra(Y, cy, propY, doc);
    // Solo se descartan las compras agregadas a mano (014): la sire no se puede descartar.
    const descartada = (await ec.compra(X, cx, { periodo: DESCARGA, origen: "agregada", docNumero: doc })).id;
    await admin.query("update compra set descartada_en = now() where id = $1", [descartada]);
    for (const [nombre, otra] of [
      ["otro cliente", deOtroCliente],
      ["otro estudio", deOtroEstudio],
      ["descartada", descartada],
      ["inexistente", uuidAjeno()],
    ] as const) {
      const r = await comoX((tx) =>
        repo.recordar(tx, { clienteId: cx.id, compraIds: [propia, otra], destino: "DNG", versionBase: null, usuarioId: ux }),
      );
      expect(r, nombre).toBe("no_encontrada");
    }
    expect(
      (await admin.query("select count(*)::int as n from regla_aprendida where cliente_id = $1 and doc_numero = $2", [cx.id, doc])).rows[0].n,
    ).toBe(0);
  });

  it("un cliente ajeno (de otro estudio) como clienteId: 'no_encontrada'", async () => {
    const a = await compra(X, cx, propX, docNuevo());
    const r = await comoX((tx) =>
      repo.recordar(tx, { clienteId: cy.id, compraIds: [a], destino: "DNG", versionBase: null, usuarioId: ux }),
    );
    expect(r).toBe("no_encontrada");
  });
});

// =================================================================================================
describe("editarRegla y eliminarRegla (compare-and-set por version, P-9, CA-7)", () => {
  it("editar el destino: version + 1, actualizada_por; version vieja: 'regla_cambiada'", async () => {
    const id = await ec.regla(X, cx, { docNumero: docNuevo(), destino: "DNG" });
    const r = await comoX((tx) => repo.editar(tx, { clienteId: cx.id, reglaId: id, versionBase: 1, destino: "DG", usuarioId: ux }));
    expect(r).toMatchObject({ id, destino: "DG", version: 2, activa: true });
    expect(await reglaDe(id)).toMatchObject({ destino: "DG", version: 2, actualizada_por: ux });
    const vieja = await comoX((tx) => repo.editar(tx, { clienteId: cx.id, reglaId: id, versionBase: 1, destino: "DGNG", usuarioId: ux }));
    expect(vieja).toBe("regla_cambiada");
    expect(await reglaDe(id)).toMatchObject({ destino: "DG", version: 2 });
  });

  it("desactivar y activar suben la version y no cambian el destino", async () => {
    const id = await ec.regla(X, cx, { docNumero: docNuevo(), destino: "DGNG" });
    const off = await comoX((tx) => repo.editar(tx, { clienteId: cx.id, reglaId: id, versionBase: 1, activa: false, usuarioId: ux }));
    expect(off).toMatchObject({ activa: false, destino: "DGNG", version: 2 });
    const on = await comoX((tx) => repo.editar(tx, { clienteId: cx.id, reglaId: id, versionBase: 2, activa: true, usuarioId: ux }));
    expect(on).toMatchObject({ activa: true, destino: "DGNG", version: 3 });
  });

  it("regla de otro cliente, de otro estudio, eliminada o inexistente: 'no_encontrada' (404 identico, CA-5)", async () => {
    const mia = await ec.regla(X, cx, { docNumero: docNuevo() });
    const ajena = await ec.regla(Y, cy, { docNumero: docNuevo() });
    const eliminada = await ec.regla(X, cx, { docNumero: docNuevo(), eliminada: true });
    for (const [nombre, clienteId, reglaId] of [
      ["de otro cliente", cx2.id, mia],
      ["de otro estudio", cx.id, ajena],
      ["eliminada", cx.id, eliminada],
      ["inexistente", cx.id, uuidAjeno()],
    ] as const) {
      expect(
        await comoX((tx) => repo.editar(tx, { clienteId, reglaId, versionBase: 1, destino: "DG", usuarioId: ux })),
        `editar ${nombre}`,
      ).toBe("no_encontrada");
      expect(
        await comoX((tx) => repo.eliminar(tx, { clienteId, reglaId, versionBase: 1, usuarioId: ux })),
        `eliminar ${nombre}`,
      ).toBe("no_encontrada");
    }
    expect(await reglaDe(mia)).toMatchObject({ destino: "DNG", version: 1, eliminada_en: null });
  });

  it("eliminar: baja logica (eliminada_en y eliminada_por), deja de listarse y de aplicarse; la fila se conserva; version vieja: 'regla_cambiada'", async () => {
    const doc = docNuevo();
    const id = await ec.regla(X, cx, { docNumero: doc });
    expect(await comoX((tx) => repo.eliminar(tx, { clienteId: cx.id, reglaId: id, versionBase: 7, usuarioId: ux }))).toBe("regla_cambiada");
    expect((await reglaDe(id)).eliminada_en).toBeNull();
    expect(await comoX((tx) => repo.eliminar(tx, { clienteId: cx.id, reglaId: id, versionBase: 1, usuarioId: ux }))).toBe("ok");
    expect(await reglaDe(id)).toMatchObject({ eliminada_por: ux });
    expect((await reglaDe(id)).eliminada_en).not.toBeNull();
    expect((await comoX((tx) => repo.listar(tx, cx.id))).map((r) => r.id)).not.toContain(id);
    expect(await comoX((tx) => repo.eliminar(tx, { clienteId: cx.id, reglaId: id, versionBase: 2, usuarioId: ux })), "ya eliminada").toBe("no_encontrada");
  });
});

// =================================================================================================
describe("listarReglas (CA-5, CA-7, P-4)", () => {
  it("lista solo las reglas vivas del cliente (ni de otro cliente, ni de otro estudio, ni eliminadas), con aplicada y aceptada en 0", async () => {
    const L = await ec.cliente(X);
    const L2 = await ec.cliente(X);
    const viva = await ec.regla(X, L, { docNumero: "20810000001", destino: "DGNG" });
    await ec.regla(X, L, { docNumero: "20810000002", eliminada: true });
    await ec.regla(X, L2, { docNumero: "20810000003" });
    await ec.regla(Y, cy, { docNumero: "20810000001" });
    const r = await comoX((tx) => repo.listar(tx, L.id));
    expect(r.map((x) => x.id)).toEqual([viva]);
    expect(r[0]).toMatchObject({
      clienteId: L.id,
      docTipo: "6",
      docNumero: "20810000001",
      destino: "DGNG",
      activa: true,
      version: 1,
      aplicada: 0,
      aceptada: 0,
    });
  });

  it("razon social de la compra del proveedor en ese cliente; nula si no hay compras; no toma la de otro cliente", async () => {
    const L = await ec.cliente(X);
    const P = await ec.propuesta(X, L, { libro: "compras", periodo: DESCARGA, nuevas: 5 });
    await ec.regla(X, L, { docNumero: "20820000001" });
    await ec.regla(X, L, { docNumero: "20820000002" });
    await compra(X, L, P, "20820000001", { razonSocial: "FERRETERIA CENTRAL SAC" });
    await compra(X, cx2, propX2, "20820000002", { razonSocial: "OTRO CLIENTE SAC" });
    const r = await comoX((tx) => repo.listar(tx, L.id));
    const por = Object.fromEntries(r.map((x) => [x.docNumero, x.razonSocial]));
    expect(por["20820000001"]).toBe("FERRETERIA CENTRAL SAC");
    expect(por["20820000002"]).toBeNull();
  });

  it("un cliente de otro estudio no devuelve nada (404 en la ruta)", async () => {
    await ec.regla(Y, cy, { docNumero: "20830000001" });
    expect(await comoX((tx) => repo.listar(tx, cy.id))).toEqual([]);
  });
});

// =================================================================================================
describe("interruptores del motor y aporte (RF-089, P-8, P-10)", () => {
  it("sin filas: lectura vacia y aporte encendido (sin fila = encendido)", async () => {
    const n = await ec.estudio();
    const u = await ec.usuarioDe(n.id);
    const r = await backend.withTenant({ tenantId: n.id, userId: u }, (tx) => repo.leerMotor(tx));
    expect(r).toEqual({ filas: [], aportarCatalogo: true });
  });

  it("fijar un interruptor lo guarda por estudio (idempotente) y no afecta a otro estudio", async () => {
    const n = await ec.estudio();
    const u = await ec.usuarioDe(n.id);
    const como = <T>(fn: (tx: Tx) => Promise<T>) => backend.withTenant({ tenantId: n.id, userId: u }, fn);
    await como((tx) => repo.fijarMotor(tx, { codigo: "R-HIS", activa: false, usuarioId: u }));
    await como((tx) => repo.fijarMotor(tx, { codigo: "R-HIS", activa: false, usuarioId: u }));
    await como((tx) => repo.fijarMotor(tx, { codigo: "R-GP", activa: false, usuarioId: u }));
    await como((tx) => repo.fijarMotor(tx, { codigo: "R-GP", activa: true, usuarioId: u }));
    const r = await como((tx) => repo.leerMotor(tx));
    expect(r.filas.sort((a, b) => a.codigo.localeCompare(b.codigo))).toEqual([
      { codigo: "R-GP", activa: true },
      { codigo: "R-HIS", activa: false },
    ]);
    const otro = await backend.withTenant({ tenantId: Y, userId: uy }, (tx) => repo.leerMotor(tx));
    expect(otro.filas.find((f) => f.codigo === "R-HIS")).toBeUndefined();
  });

  it("un codigo fuera del catalogo (incluida la prevalidacion) lo rechaza el CHECK (23514)", async () => {
    for (const codigo of ["R-XXX", "PREVALIDACION"]) {
      expect(
        await codigoDe(comoX((tx) => repo.fijarMotor(tx, { codigo, activa: false, usuarioId: ux }))),
        codigo,
      ).toMatch(/23514/);
    }
  });

  it("fijarAporte guarda el aporte del estudio y lo lee leerReglasMotor", async () => {
    const n = await ec.estudio();
    const u = await ec.usuarioDe(n.id);
    const como = <T>(fn: (tx: Tx) => Promise<T>) => backend.withTenant({ tenantId: n.id, userId: u }, fn);
    await como((tx) => repo.fijarAporte(tx, { aportar: false, usuarioId: u }));
    expect((await como((tx) => repo.leerMotor(tx))).aportarCatalogo).toBe(false);
    await como((tx) => repo.fijarAporte(tx, { aportar: true, usuarioId: u }));
    expect((await como((tx) => repo.leerMotor(tx))).aportarCatalogo).toBe(true);
  });
});

// =================================================================================================
describe("auditoria de las acciones de reglas (plan: Contratos · BD; CA-7, CA-13)", () => {
  const NUEVAS = [
    "regla.creada",
    "regla.editada",
    "regla.activada",
    "regla.desactivada",
    "regla.eliminada",
    "estudio.regla_motor",
    "estudio.aporte_catalogo",
    "compra.historial",
  ] as const;

  it("el CHECK de accion admite las ocho nuevas y sigue rechazando las ajenas al catalogo (23514)", async () => {
    const INSERT = `insert into auditoria (tenant_id, actor_tipo, usuario_id, accion, cliente_id, entidad, entidad_id, datos)
      values ($1, 'usuario', $2, $3, $4, 'regla_aprendida', $5, '{}'::jsonb)`;
    for (const accion of NUEVAS) {
      expect(
        await enRevertida(admin, async (c) => {
          await c.query(INSERT, [X, ux, accion, cx.id, uuidAjeno()]);
        }),
        accion,
      ).toEqual({ ok: true });
    }
    const mala = await enRevertida(admin, async (c) => {
      await c.query(INSERT, [X, ux, "regla.borrada", cx.id, uuidAjeno()]);
    });
    expect(mala.ok ? "ok" : mala.code).toBe("23514");
  });

  const filasNuevas = async (accion: string, hacer: () => Promise<unknown>): Promise<FilaAud[]> =>
    (await ec.capturar(X, accion, hacer)).filas;

  const sinPersonales = (f: FilaAud, ...prohibidos: string[]) => {
    const t = JSON.stringify(f.datos);
    for (const p of prohibidos) expect(t, p).not.toContain(p);
  };

  it("regla.creada: una fila al recordar, actor usuario, entidad regla_aprendida, datos con el destino y sin RUC ni razon social", async () => {
    const doc = docNuevo();
    const a = await compra(X, cx, propX, doc, { razonSocial: "CANARIO AUDITORIA SAC" });
    let id = "";
    const filas = await filasNuevas("regla.creada", async () => {
      id = ((await comoX((tx) =>
        repo.recordar(tx, { clienteId: cx.id, compraIds: [a], destino: "DNG", versionBase: null, usuarioId: ux }),
      )) as ReglaFila).id;
    });
    expect(filas).toHaveLength(1);
    const f = filas[0]!;
    expect([f.actor_tipo, f.usuario_id, f.cliente_id, f.entidad, f.entidad_id]).toEqual([
      "usuario",
      ux,
      cx.id,
      "regla_aprendida",
      id,
    ]);
    expect(f.datos).toMatchObject({ destino: "DNG" });
    sinPersonales(f, doc, "CANARIO", "PROVEEDOR");
  });

  it("regla.editada: datos exactos {destino: {anterior, nuevo}} al cambiar el destino", async () => {
    const id = await ec.regla(X, cx, { docNumero: docNuevo(), destino: "DNG" });
    const filas = await filasNuevas("regla.editada", () =>
      comoX((tx) => repo.editar(tx, { clienteId: cx.id, reglaId: id, versionBase: 1, destino: "DG", usuarioId: ux })),
    );
    expect(filas).toHaveLength(1);
    expect(filas[0]!.datos).toEqual({ destino: { anterior: "DNG", nuevo: "DG" } });
    expect([filas[0]!.actor_tipo, filas[0]!.usuario_id, filas[0]!.entidad_id]).toEqual(["usuario", ux, id]);
  });

  it("regla.desactivada y regla.activada: una fila cada una; cambiar solo el estado no genera regla.editada", async () => {
    const id = await ec.regla(X, cx, { docNumero: docNuevo() });
    const editadas = await filasNuevas("regla.editada", async () => {
      const off = await filasNuevas("regla.desactivada", () =>
        comoX((tx) => repo.editar(tx, { clienteId: cx.id, reglaId: id, versionBase: 1, activa: false, usuarioId: ux })),
      );
      expect(off).toHaveLength(1);
      expect(off[0]!.entidad_id).toBe(id);
      const on = await filasNuevas("regla.activada", () =>
        comoX((tx) => repo.editar(tx, { clienteId: cx.id, reglaId: id, versionBase: 2, activa: true, usuarioId: ux })),
      );
      expect(on).toHaveLength(1);
    });
    expect(editadas).toEqual([]);
  });

  it("reactivar una regla inactiva al recordarla se audita como regla.editada y regla.activada", async () => {
    const doc = docNuevo();
    const id = await ec.regla(X, cx, { docNumero: doc, activa: false, destino: "DNG" });
    const a = await compra(X, cx, propX, doc);
    let activadas: FilaAud[] = [];
    const editadas = await filasNuevas("regla.editada", async () => {
      activadas = await filasNuevas("regla.activada", () =>
        comoX((tx) => repo.recordar(tx, { clienteId: cx.id, compraIds: [a], destino: "DGNG", versionBase: 1, usuarioId: ux })),
      );
    });
    expect(editadas.map((f) => [f.entidad_id, f.datos])).toEqual([[id, { destino: { anterior: "DNG", nuevo: "DGNG" } }]]);
    expect(activadas.map((f) => f.entidad_id)).toEqual([id]);
  });

  it("regla.eliminada: una fila al eliminar, sin RUC", async () => {
    const doc = docNuevo();
    const id = await ec.regla(X, cx, { docNumero: doc });
    const filas = await filasNuevas("regla.eliminada", () =>
      comoX((tx) => repo.eliminar(tx, { clienteId: cx.id, reglaId: id, versionBase: 1, usuarioId: ux })),
    );
    expect(filas).toHaveLength(1);
    expect([filas[0]!.entidad_id, filas[0]!.usuario_id, filas[0]!.cliente_id]).toEqual([id, ux, cx.id]);
    sinPersonales(filas[0]!, doc);
  });

  it("una escritura rechazada por version vieja no deja auditoria", async () => {
    const id = await ec.regla(X, cx, { docNumero: docNuevo(), version: 3 });
    const antes = await ec.cuantas(X);
    await comoX((tx) => repo.editar(tx, { clienteId: cx.id, reglaId: id, versionBase: 1, destino: "DG", usuarioId: ux }));
    expect(await ec.cuantas(X)).toBe(antes);
  });

  it("estudio.regla_motor: datos exactos {codigo, activa}; estudio.aporte_catalogo: una fila al cambiar el aporte", async () => {
    const n = await ec.estudio();
    const u = await ec.usuarioDe(n.id);
    const como = <T>(fn: (tx: Tx) => Promise<T>) => backend.withTenant({ tenantId: n.id, userId: u }, fn);
    const motor = await ec.capturar(n.id, "estudio.regla_motor", () =>
      como((tx) => repo.fijarMotor(tx, { codigo: "R-HIS", activa: false, usuarioId: u })),
    );
    expect(motor.filas).toHaveLength(1);
    expect(motor.filas[0]!.datos).toEqual({ codigo: "R-HIS", activa: false });
    expect([motor.filas[0]!.actor_tipo, motor.filas[0]!.usuario_id]).toEqual(["usuario", u]);
    const aporte = await ec.capturar(n.id, "estudio.aporte_catalogo", () =>
      como((tx) => repo.fijarAporte(tx, { aportar: false, usuarioId: u })),
    );
    expect(aporte.filas).toHaveLength(1);
    expect([aporte.filas[0]!.actor_tipo, aporte.filas[0]!.usuario_id]).toEqual(["usuario", u]);
  });
});

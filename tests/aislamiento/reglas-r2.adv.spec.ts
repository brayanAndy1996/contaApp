// Spec 021 · T19: ronda adversarial 2 sobre la BD de reglas aprendidas. Caja negra (spec, plan) y luego blanca (0048–0050,
// `packages/db/src/reglas/`, `packages/db/src/compras/lectura.ts`). Frentes: dinero con R-HIS (notas de crédito, USD con tipo de
// cambio de 3 decimales, IGV 10 % y 18 %, base 0 con IGV, montos al borde de NUMERIC(14,2), cadenas de monto raras), aceptaciones
// y confirmaciones (reabrir y volver a revisar, deshacer una corrección, fila sin base, regla que vuelve a su destino), el
// interruptor R-NEW y la baja lógica (eliminar y volver a recordar). Las correcciones de la ronda 1 (0050) también se atacan.
// Una prueba marcada `it.fails` es un hallazgo H-021-2-n; las demás quedan como regresión.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { abrirAdmin, exportado } from "./auth-soporte";
import { claveCompra } from "./compras-soporte";
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
  montosDeFila,
  type Destino,
  type Montos,
} from "./reglas-soporte";

let admin: Pool;
let ec: EscenarioReglas;
let worker: ContappDb;
let backend: ContappDb;
let X: string;
let Z: string;
let ux: string;
let uz: string;
let errSiembra: unknown;

beforeAll(async () => {
  admin = abrirAdmin(6);
  ec = new EscenarioReglas(admin);
  try {
    X = (await ec.estudio()).id;
    Z = (await ec.estudio()).id;
    ux = await ec.usuarioDe(X);
    uz = await ec.usuarioDe(Z);
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
const num = () => String(9200 + ++consecutivo);
const SQL_APLICAR = "select public.aplicar_regla_historial($1, $2, $3::jsonb)";

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

/** Compra nueva del worker en `tx` con moneda y tipo de cambio a elección (compraDelWorker solo hace PEN). */
async function compraMoneda(
  tx: Tx,
  clienteId: string,
  propuestaId: string,
  o: { numero: string; docNumero: string; montos: Montos; moneda: "PEN" | "USD"; tipoCambio: string | null },
): Promise<string> {
  const c = await tx.query(
    `insert into compra (cliente_id, periodo, propuesta_id, clave, tipo_doc, serie, numero, doc_tipo, doc_numero, razon_social,
       fecha, moneda, tipo_cambio, origen, version_vigente)
     values ($1, $2, $3, $4, '01', 'F001', $5, '6', $6, 'PROVEEDOR SINTETICO SAC', '2026-10-05', $7, $8, 'sire', 1) returning id`,
    [clienteId, DESCARGA, propuestaId, claveCompra("01", "F001", o.numero, "6", o.docNumero), o.numero, o.docNumero, o.moneda,
      o.tipoCambio],
  );
  const id = c.rows[0].id as string;
  const m = o.montos;
  await tx.query(
    `insert into compra_version (compra_id, n, bi_dg, igv_dg, bi_dgng, igv_dgng, bi_dng, igv_dng, no_gravado, isc, icbper,
       otros_tributos, total, excluida, motivo, clasificada, accion, operacion_id, usuario_id)
     values ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, false, null, false, 'original', null, null)`,
    [id, m.biDg, m.igvDg, m.biDgng, m.igvDgng, m.biDng, m.igvDng, m.noGravado, m.isc, m.icbper, m.otrosTributos, m.total],
  );
  return id;
}

const version = async (compraId: string, n: number): Promise<Record<string, string> | undefined> =>
  (await admin.query("select * from compra_version where compra_id = $1 and n = $2", [compraId, n])).rows[0];

const fijarEstadoPeriodo = (tx: Tx, clienteId: string, periodo: string, desde: string, hacia: string, usuarioId: string) =>
  exportado<(tx: Tx, c: string, p: string, d: string, h: string, u: string) => Promise<unknown>>("fijarEstadoPeriodo")(
    tx,
    clienteId,
    periodo,
    desde,
    hacia,
    usuarioId,
  );

interface FilaListado {
  compra: { id: string };
  proveedorNuevo: boolean;
  segunHistorial: { reglaId: string } | null;
}
const listar = (tenantId: string, userId: string, clienteId: string, filtros: Record<string, unknown> = {}) =>
  backend.withTenant({ tenantId, userId }, async (tx) =>
    (
      await exportado<(tx: Tx, c: string, p: string, f: unknown) => Promise<{ filas: FilaListado[] }>>("listarCompras")(
        tx,
        clienteId,
        DESCARGA,
        { limite: 100, ...filtros },
      )
    ).filas,
  );

interface Escenario {
  c: ClientePrueba;
  regla: string;
  compras: string[];
}

/** Cliente con una regla y `n` compras de 202610 con versión 2 `historial` (por la función real de 0048), periodo abierto. */
async function escenario(n: number, o: { destino?: Destino; m?: Montos } = {}): Promise<Escenario> {
  const destino = o.destino ?? "DNG";
  const m = o.m ?? FACTURA_DG;
  const c = await ec.cliente(X);
  const prop = await ec.propuesta(X, c, { libro: "compras", periodo: DESCARGA, nuevas: 10 });
  const d = doc();
  const regla = await ec.regla(X, c, { docNumero: d, destino });
  await ec.estadoPeriodo(X, c, DESCARGA, "abierto", null);
  const compras = await worker.withTenant({ tenantId: X }, async (tx) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = await compraDelWorker(tx, c.id, prop, DESCARGA, { serie: "F77", numero: num(), docNumero: d, montos: m });
      expect(await aplicar(tx, id, regla, consolidar(m, destino))).toBe(2);
      ids.push(id);
    }
    return ids;
  });
  return { c, regla, compras };
}
const pasar = (e: Escenario, desde: string, hacia: string) =>
  backend.withTenant({ tenantId: X, userId: ux }, (tx) => fijarEstadoPeriodo(tx, e.c.id, DESCARGA, desde, hacia, ux));
const aceptadas = async (regla: string): Promise<string[]> =>
  (
    await admin.query(
      `select p.compra_id from regla_aceptacion a join regla_aplicacion p on p.id = a.regla_aplicacion_id
        where a.regla_id = $1 order by p.compra_id`,
      [regla],
    )
  ).rows.map((r) => r.compra_id as string);
const confirmacionesAceptadas = async (regla: string): Promise<string[]> =>
  (await admin.query("select destino from regla_confirmacion where regla_id = $1 and origen = 'aceptada'", [regla])).rows.map(
    (r) => r.destino as string,
  );

// ===================================================================================================================
// Dinero con R-HIS: la función recalcula la consolidación en NUMERIC y falla cerrado (D-6, D-7, plan «Decisiones técnicas»)
// ===================================================================================================================

describe("R2 · dinero con R-HIS en aplicar_regla_historial", () => {
  it("nota de crédito (todo negativo, tres destinos): versión 2 = consolidación exacta en DNG, total igual; al revisar cuenta", async () => {
    const m = montos({
      biDg: "-1000.00",
      igvDg: "-180.00",
      biDgng: "-200.50",
      igvDgng: "-36.09",
      biDng: "-0.01",
      noGravado: "-15.00",
    });
    const e = await escenario(1, { m });
    const v1 = await version(e.compras[0]!, 1);
    const v2 = await version(e.compras[0]!, 2);
    expect(montosDeFila(v2!)).toEqual(consolidar(m, "DNG"));
    expect(v2!.bi_dng).toBe("-1200.51");
    expect(v2!.igv_dng).toBe("-216.09");
    expect(v2!.total).toBe(v1!.total);
    await pasar(e, "abierto", "revisado");
    expect(await aceptadas(e.regla)).toEqual(e.compras);
    expect(await confirmacionesAceptadas(e.regla)).toEqual(["DNG"]);
  });

  it("USD con tipo de cambio de 3 decimales e IGV 10 % y 18 % mezclados: suma en la moneda de la fila, sin convertir", async () => {
    const c = await ec.cliente(X);
    const prop = await ec.propuesta(X, c, { libro: "compras", periodo: DESCARGA, nuevas: 5 });
    const d = doc();
    const regla = await ec.regla(X, c, { docNumero: d, destino: "DG" });
    // DG al 10 % (restaurante MYPE), DGNG al 18 % y un céntimo en DNG: la consolidación no recalcula tasas ni convierte.
    const m = montos({ biDg: "500.00", igvDg: "50.00", biDgng: "300.00", igvDgng: "54.00", biDng: "0.10", igvDng: "0.01" });
    const r = await enRollback(worker, { tenantId: X }, async (tx) => {
      const id = await compraMoneda(tx, c.id, prop, { numero: num(), docNumero: d, montos: m, moneda: "USD", tipoCambio: "3.512" });
      const n = await aplicar(tx, id, regla, consolidar(m, "DG"));
      const cab = (
        await tx.query(
          `select c.moneda, c.tipo_cambio::text as tc, v.* from compra c
             join compra_version v on v.compra_id = c.id and v.n = 2 where c.id = $1`,
          [id],
        )
      ).rows[0];
      return { n, cab };
    });
    expect(r.n).toBe(2);
    expect(r.cab.moneda).toBe("USD");
    expect(r.cab.tc).toBe("3.512");
    expect(montosDeFila(r.cab)).toEqual(consolidar(m, "DG"));
    expect(r.cab.bi_dg).toBe("800.10");
    expect(r.cab.igv_dg).toBe("104.01");
  });

  it("base 0 con IGV ≠ 0: 42501 (D-7); BI ya en el destino pero IGV en otro par: sí se aplica (frontera del fix H-021-1-4)", async () => {
    const c = await ec.cliente(X);
    const prop = await ec.propuesta(X, c, { libro: "compras", periodo: DESCARGA, nuevas: 5 });
    const d = doc();
    const regla = await ec.regla(X, c, { docNumero: d, destino: "DNG" });
    const sinBase = montos({ igvDg: "18.00", noGravado: "100.00" });
    const igvFuera = montos({ biDng: "1000.00", igvDg: "180.00" });
    const r = await enRollback(worker, { tenantId: X }, async (tx) => {
      const a = await compraDelWorker(tx, c.id, prop, DESCARGA, { numero: num(), docNumero: d, montos: sinBase });
      const b = await compraDelWorker(tx, c.id, prop, DESCARGA, { numero: num(), docNumero: d, montos: igvFuera });
      return {
        sinBase: await estado(tx, SQL_APLICAR, [a, regla, JSON.stringify(datosJson(consolidar(sinBase, "DNG")))]),
        igvFuera: await estado(tx, SQL_APLICAR, [b, regla, JSON.stringify(datosJson(consolidar(igvFuera, "DNG")))]),
      };
    });
    expect(r).toEqual({ sinBase: "42501", igvFuera: "ok" });
  });

  it("montos al borde de NUMERIC(14,2) cuya suma lo desborda: 42501 de mensaje fijo, nunca 22003 ni una versión", async () => {
    const c = await ec.cliente(X);
    const prop = await ec.propuesta(X, c, { libro: "compras", periodo: DESCARGA, nuevas: 5 });
    const d = doc();
    const regla = await ec.regla(X, c, { docNumero: d, destino: "DNG" });
    const m = montos({ biDg: "999999999999.99", biDgng: "0.01", total: "999999999999.99" });
    const r = await enRollback(worker, { tenantId: X }, async (tx) => {
      const id = await compraDelWorker(tx, c.id, prop, DESCARGA, { numero: num(), docNumero: d, montos: m });
      const s = await estado(tx, SQL_APLICAR, [id, regla, JSON.stringify(datosJson(consolidar(m, "DNG")))]);
      const versiones = (await tx.query("select n from compra_version where compra_id = $1", [id])).rows.map((x) => x.n);
      return { s, versiones };
    });
    expect(r).toEqual({ s: "42501", versiones: [1] });
  });

  it("cadenas de monto raras en p_datos (0.005, 1e3, espacios, signo +, separador de miles): 42501", async () => {
    const c = await ec.cliente(X);
    const prop = await ec.propuesta(X, c, { libro: "compras", periodo: DESCARGA, nuevas: 5 });
    const d = doc();
    const regla = await ec.regla(X, c, { docNumero: d, destino: "DNG" });
    const base = datosJson(consolidar(FACTURA_DG, "DNG"));
    const r = await enRollback(worker, { tenantId: X }, async (tx) => {
      const id = await compraDelWorker(tx, c.id, prop, DESCARGA, { numero: num(), docNumero: d });
      const sal: Record<string, string> = {};
      for (const v of ["1000.005", "1e3", " 1000.00", "1000.00 ", "+1000.00", "1,000.00", "1000.", ".5"]) {
        sal[v] = await estado(tx, SQL_APLICAR, [id, regla, JSON.stringify({ ...base, bi_dng: v })]);
      }
      sal.control = await estado(tx, SQL_APLICAR, [id, regla, JSON.stringify(base)]);
      return sal;
    });
    const { control, ...raras } = r;
    expect(Object.values(raras).every((s) => s === "42501")).toBe(true);
    expect(control).toBe("ok");
  });
});

// ===================================================================================================================
// Aceptaciones y confirmaciones (P-1, P-4, criterios del plan (3) y (4), correcciones H-021-1-5/6 de 0050)
// ===================================================================================================================

describe("R2 · aceptaciones y confirmaciones al revisar", () => {
  // H-021-2-1: `regla_aceptar_periodo` solo exige que los OTROS dos pares estén en 0. Una fila que el contador dejó sin base
  // gravada (todo a no gravado) no está en ningún destino, pero cuenta como aceptada y confirma DNG para el catálogo (033).
  it.fails("H-021-2-1 · fila «Según historial» que el contador deja sin base gravada (todo a no gravado): no es aceptada ni confirma", async () => {
    const e = await escenario(1);
    await ec.version(X, e.compras[0]!, 3, { accion: "editar", usuarioId: ux, montos: montos({ noGravado: "1180.00" }) });
    await pasar(e, "abierto", "revisado");
    expect(await aceptadas(e.regla)).toEqual([]);
    expect(await confirmacionesAceptadas(e.regla)).toEqual([]);
  });

  // H-021-2-2: deshacer la corrección deja la fila otra vez con los montos que puso la regla (copia de la versión `historial`),
  // pero `segunHistorial` mira solo si la vigente tiene fila en regla_aplicacion: la etiqueta no vuelve y el filtro «Según
  // historial» (con el que se revierte en masa, CA-3) ya no la encuentra. Es una fila clasificada por el sistema sin su marca.
  it.fails("H-021-2-2 · corregir una fila «Según historial» y deshacer la corrección: vuelve la etiqueta y el filtro la encuentra", async () => {
    const e = await escenario(1);
    const id = e.compras[0]!;
    await ec.version(X, id, 3, { accion: "clasificar", usuarioId: ux, montos: consolidar(FACTURA_DG, "DG") });
    await ec.version(X, id, 4, { accion: "deshacer", usuarioId: ux, montos: consolidar(FACTURA_DG, "DNG") });
    expect(montosDeFila((await version(id, 4))!)).toEqual(montosDeFila((await version(id, 2))!));
    const filas = await listar(X, ux, e.c.id);
    expect(filas.find((f) => f.compra.id === id)?.segunHistorial).toEqual({ reglaId: e.regla });
    const filtradas = await listar(X, ux, e.c.id, { segunHistorial: true });
    expect(filtradas.map((f) => f.compra.id)).toContain(id);
  });

  it("excluida al revisar (no cuenta), reabrir, restaurar y volver a revisar: cuenta una vez y deja una sola confirmación", async () => {
    const e = await escenario(1);
    const id = e.compras[0]!;
    await ec.version(X, id, 3, { accion: "excluir", excluida: true, motivo: "no corresponde", usuarioId: ux });
    await pasar(e, "abierto", "revisado");
    expect(await aceptadas(e.regla)).toEqual([]);
    await pasar(e, "revisado", "abierto");
    await ec.version(X, id, 4, { accion: "restaurar", excluida: false, motivo: null, usuarioId: ux });
    await pasar(e, "abierto", "revisado");
    await pasar(e, "revisado", "abierto");
    await pasar(e, "abierto", "revisado");
    expect(await aceptadas(e.regla)).toEqual([id]);
    expect(await confirmacionesAceptadas(e.regla)).toEqual(["DNG"]);
  });

  it("regla editada DNG → DG → DNG con la fila intacta: cuenta (el fix H-021-1-5 no castiga la vuelta al destino)", async () => {
    const e = await escenario(1);
    await admin.query("update regla_aprendida set destino = 'DG', version = version + 1 where id = $1", [e.regla]);
    await admin.query("update regla_aprendida set destino = 'DNG', version = version + 1 where id = $1", [e.regla]);
    await pasar(e, "abierto", "revisado");
    expect(await aceptadas(e.regla)).toEqual(e.compras);
    expect(await confirmacionesAceptadas(e.regla)).toEqual(["DNG"]);
  });
});

// ===================================================================================================================
// Interruptores (RF-089, CA-8, D-7)
// ===================================================================================================================

describe("R2 · interruptores del motor", () => {
  // H-021-2-3: R-NEW («Avisa cuando un proveedor no tiene historial en el cliente») apagado en el estudio sigue marcando
  // «Proveedor nuevo» en la grilla y la lupa: el listado lo calcula en SQL sin leer los interruptores (solo `evaluar` los lee).
  it.fails("H-021-2-3 · con R-NEW apagado, el listado no marca «Proveedor nuevo» (con R-NEW encendido sí: control)", async () => {
    const cx = await ec.cliente(X);
    const cz = await ec.cliente(Z);
    await ec.interruptor(Z, "R-NEW", false);
    const d = doc();
    const ax = await ec.compra(X, cx, { periodo: DESCARGA, docNumero: d, numero: num() });
    const az = await ec.compra(Z, cz, { periodo: DESCARGA, docNumero: d, numero: num() });
    const enX = (await listar(X, ux, cx.id)).find((f) => f.compra.id === ax.id);
    expect(enX?.proveedorNuevo).toBe(true);
    const enZ = (await listar(Z, uz, cz.id)).find((f) => f.compra.id === az.id);
    expect(enZ?.proveedorNuevo).toBe(false);
  });
});

// ===================================================================================================================
// Baja lógica (P-9, CA-7)
// ===================================================================================================================

describe("R2 · eliminar y volver a recordar", () => {
  it("la fila pasada conserva la etiqueta de la regla eliminada; la nueva no hereda contadores y es la única vigente", async () => {
    const e = await escenario(1);
    const id = e.compras[0]!;
    const r = await backend.withTenant({ tenantId: X, userId: ux }, async (tx) => {
      const eliminada = await exportado<(tx: Tx, e: unknown) => Promise<string>>("eliminarRegla")(tx, {
        clienteId: e.c.id,
        reglaId: e.regla,
        versionBase: 1,
        usuarioId: ux,
      });
      const nueva = await exportado<(tx: Tx, e: unknown) => Promise<{ id: string; periodoAprendido: string } | string>>(
        "recordarRegla",
      )(tx, { clienteId: e.c.id, compraIds: [id], destino: "DG", versionBase: null, usuarioId: ux });
      return { eliminada, nueva };
    });
    expect(r.eliminada).toBe("ok");
    expect(typeof r.nueva).toBe("object");
    const nueva = r.nueva as { id: string; periodoAprendido: string };
    expect(nueva.id).not.toBe(e.regla);
    expect(nueva.periodoAprendido).toBe(DESCARGA);

    const fila = (await listar(X, ux, e.c.id)).find((f) => f.compra.id === id);
    expect(fila?.segunHistorial).toEqual({ reglaId: e.regla });

    await pasar(e, "abierto", "revisado");
    const reglas = await backend.withTenant({ tenantId: X, userId: ux }, (tx) =>
      exportado<(tx: Tx, c: string) => Promise<{ id: string; aplicada: number; aceptada: number }[]>>("listarReglas")(tx, e.c.id),
    );
    expect(reglas.map((x) => ({ id: x.id, aplicada: x.aplicada, aceptada: x.aceptada }))).toEqual([
      { id: nueva.id, aplicada: 0, aceptada: 0 },
    ]);
    const vigentes = await enRollback(worker, { tenantId: X }, async (tx) =>
      (await tx.query("select regla_id, destino from public.reglas_historial_vigentes($1, '202611')", [e.c.id])).rows,
    );
    expect(vigentes).toEqual([{ regla_id: nueva.id, destino: "DG" }]);
  });
});

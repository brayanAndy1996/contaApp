// Spec 021 (T3, rojo): al pasar un periodo a `revisado` (trigger SECURITY DEFINER de 0049 sobre `compra_periodo`) se registran las
// aceptaciones (`regla_aceptacion`) de las filas «Segun historial» que siguen en el destino de la regla y, solo para RUC 20 con el
// aporte encendido, la confirmacion `aceptada` (`regla_confirmacion`). Cubre P-1, P-4, P-10, D-3, D-8, CA-6 y CA-7 (contadores).
// Las filas «Segun historial» se crean por la funcion real de 0048 (el trigger rechaza `accion = historial` sembrada a mano), asi que
// estas pruebas tambien dependen de ella. Contrato en el encabezado de `reglas-soporte.ts`. Hasta T9 fallan: tablas y funciones ausentes.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { abrirAdmin, exportado } from "./auth-soporte";
import { type ContappDb, type Tx } from "./soporte";
import { crearDb, type ClientePrueba } from "./trabajos-soporte";
import {
  aplicar,
  compraDelWorker,
  consolidar,
  DESCARGA,
  EscenarioReglas,
  FACTURA_DG,
  type Destino,
} from "./reglas-soporte";

let admin: Pool;
let ec: EscenarioReglas;
let worker: ContappDb;
let backend: ContappDb;
let X: string; // aporte por defecto (encendido)
let W: string; // aporte apagado (P-10)
let ux: string;
let uw: string;
let errSiembra: unknown;

beforeAll(async () => {
  admin = abrirAdmin(8);
  ec = new EscenarioReglas(admin);
  X = (await ec.estudio()).id;
  W = (await ec.estudio()).id;
  ux = await ec.usuarioDe(X);
  uw = await ec.usuarioDe(W);
  worker = crearDb("contapp_worker", 4);
  backend = crearDb("contapp_backend", 4);
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
    [worker?.close(), backend?.close(), ec?.cerrar()].map((p) =>
      p?.catch(() => undefined),
    ),
  );
  await admin?.end();
});

interface ReglaFila {
  id: string;
  destino: string;
  aplicada: number;
  aceptada: number;
}
const listarReglas = (tx: Tx, clienteId: string) =>
  exportado<(tx: Tx, c: string) => Promise<ReglaFila[]>>("listarReglas")(tx, clienteId);
const fijarEstadoPeriodo = (
  tx: Tx,
  clienteId: string,
  periodo: string,
  desde: string,
  hacia: string,
  usuarioId: string,
) =>
  exportado<(tx: Tx, c: string, p: string, d: string, h: string, u: string) => Promise<unknown>>(
    "fijarEstadoPeriodo",
  )(tx, clienteId, periodo, desde, hacia, usuarioId);

let consecutivo = 0;

interface Escenario {
  tenant: string;
  usuario: string;
  c: ClientePrueba;
  regla: string;
  compras: string[];
  doc: string;
}

/** Cliente nuevo con una regla y `n` compras de ese proveedor en 202610 con version 2 `historial` (creadas por la funcion de 0048). */
async function escenario(
  o: {
    tenant?: string;
    docTipo?: string;
    docNumero?: string;
    destino?: Destino;
    n?: number;
    estado?: "abierto" | "revisado";
    cliente?: ClientePrueba;
  } = {},
): Promise<Escenario> {
  const tenant = o.tenant ?? X;
  const usuario = tenant === W ? uw : ux;
  const c = o.cliente ?? (await ec.cliente(tenant));
  const doc = o.docNumero ?? `20${String(600000000 + ++consecutivo)}`;
  const destino = o.destino ?? "DNG";
  const prop = await ec.propuesta(tenant, c, { libro: "compras", periodo: DESCARGA, nuevas: 20 });
  const regla = await ec.regla(tenant, c, { docTipo: o.docTipo ?? "6", docNumero: doc, destino });
  if (!o.cliente) await ec.estadoPeriodo(tenant, c, DESCARGA, o.estado ?? "abierto", o.estado === "revisado" ? usuario : null);
  const compras = await worker.withTenant({ tenantId: tenant }, async (tx) => {
    const ids: string[] = [];
    for (let i = 0; i < (o.n ?? 4); i++) {
      const id = await compraDelWorker(tx, c.id, prop, DESCARGA, {
        serie: "F77",
        numero: String(++consecutivo),
        docTipo: o.docTipo ?? "6",
        docNumero: doc,
      });
      await aplicar(tx, id, regla, consolidar(FACTURA_DG, destino));
      ids.push(id);
    }
    return ids;
  });
  return { tenant, usuario, c, regla, compras, doc };
}

const revisar = (e: Escenario) =>
  backend.withTenant({ tenantId: e.tenant, userId: e.usuario }, (tx) =>
    fijarEstadoPeriodo(tx, e.c.id, DESCARGA, "abierto", "revisado", e.usuario),
  );
const reabrir = (e: Escenario) =>
  backend.withTenant({ tenantId: e.tenant, userId: e.usuario }, (tx) =>
    fijarEstadoPeriodo(tx, e.c.id, DESCARGA, "revisado", "abierto", e.usuario),
  );

/** Corrige la compra a otra clasificacion (version n con accion `editar`, hecha a mano como el usuario). */
const corregir = (e: Escenario, compra: string, n: number, destino: Destino) =>
  ec.version(e.tenant, compra, n, {
    accion: "editar",
    usuarioId: e.usuario,
    montos: consolidar(FACTURA_DG, destino),
  });

const aceptaciones = async (regla: string) =>
  (
    await admin.query(
      `select a.regla_aplicacion_id, a.regla_id, a.periodo, p.compra_id
         from regla_aceptacion a join regla_aplicacion p on p.id = a.regla_aplicacion_id
        where a.regla_id = $1 order by p.compra_id`,
      [regla],
    )
  ).rows as { regla_aplicacion_id: string; regla_id: string; periodo: string; compra_id: string }[];
const confirmaciones = async (regla: string) =>
  (
    await admin.query(
      "select regla_id, cliente_id, ruc_proveedor, destino, origen from regla_confirmacion where regla_id = $1 order by origen",
      [regla],
    )
  ).rows as { regla_id: string; cliente_id: string; ruc_proveedor: string; destino: string; origen: string }[];

// =================================================================================================
describe("0049 · aceptaciones al pasar a revisado (P-1, P-4, D-8)", () => {
  it("antes de revisar no hay aceptaciones ni confirmaciones; aplicada cuenta las filas con version historial", async () => {
    const e = await escenario({ n: 3 });
    expect(await aceptaciones(e.regla)).toEqual([]);
    expect(await confirmaciones(e.regla)).toEqual([]);
    const r = await backend.withTenant({ tenantId: X, userId: ux }, (tx) => listarReglas(tx, e.c.id));
    expect(r).toHaveLength(1);
    expect([r[0]!.aplicada, r[0]!.aceptada]).toEqual([3, 0]);
  });

  it("al pasar a revisado: aceptacion de las filas que siguen en el destino y no de las corregidas (P-4)", async () => {
    const e = await escenario({ n: 4 });
    const [c1, c2, c3, c4] = e.compras as [string, string, string, string];
    await corregir(e, c3, 3, "DG"); // el contador la devolvio a DG
    await corregir(e, c4, 3, "DGNG"); // o a otro destino
    // c2: edita otro campo y sigue en el destino de la regla -> cuenta.
    await ec.version(e.tenant, c2, 3, { accion: "editar", usuarioId: e.usuario, montos: { noGravado: "5.00" } });
    await revisar(e);
    const a = await aceptaciones(e.regla);
    expect(a.map((x) => x.compra_id).sort()).toEqual([c1, c2].sort());
    expect(a.every((x) => x.regla_id === e.regla && x.periodo === DESCARGA)).toBe(true);
    const r = await backend.withTenant({ tenantId: X, userId: ux }, (tx) => listarReglas(tx, e.c.id));
    expect([r[0]!.aplicada, r[0]!.aceptada]).toEqual([4, 2]);
  });

  it("reabrir y volver a revisar no duplica; solo suma las que faltaban (ON CONFLICT DO NOTHING)", async () => {
    const e = await escenario({ n: 3 });
    const [c1, c2, c3] = e.compras as [string, string, string];
    await corregir(e, c3, 3, "DG");
    await revisar(e);
    expect(await aceptaciones(e.regla)).toHaveLength(2);
    await reabrir(e);
    await corregir(e, c3, 4, "DNG"); // la devuelve al destino de la regla
    await revisar(e);
    const a = await aceptaciones(e.regla);
    expect(a.map((x) => x.compra_id).sort()).toEqual([c1, c2, c3].sort());
    expect(new Set(a.map((x) => x.regla_aplicacion_id)).size, "sin duplicados").toBe(3);
    await reabrir(e);
    await revisar(e);
    expect(await aceptaciones(e.regla), "tercera revision sin cambios").toHaveLength(3);
  });

  it("las aceptaciones quedan congeladas: corregir despues de revisar y reabrir no las borra", async () => {
    const e = await escenario({ n: 2 });
    await revisar(e);
    expect(await aceptaciones(e.regla)).toHaveLength(2);
    await reabrir(e);
    await corregir(e, e.compras[0]!, 3, "DG");
    await revisar(e);
    expect(await aceptaciones(e.regla), "la de la fila corregida sigue registrada").toHaveLength(2);
  });

  it("solo el paso a revisado cuenta: abierto -> generado, o revisado -> generado, no registra aceptaciones nuevas", async () => {
    const e = await escenario({ n: 2 });
    await admin.query(
      "update compra_periodo set estado = 'generado', marcado_por = $3, marcado_en = now() where cliente_id = $1 and periodo = $2",
      [e.c.id, DESCARGA, e.usuario],
    );
    expect(await aceptaciones(e.regla)).toEqual([]);
    expect(await confirmaciones(e.regla)).toEqual([]);
  });

  it("no mezcla clientes ni periodos: revisar al cliente A no acepta las filas del cliente B (mismo proveedor y periodo)", async () => {
    const a = await escenario({ n: 2, docNumero: "20611111111" });
    const b = await escenario({ n: 2, docNumero: "20611111111" });
    await revisar(a);
    expect((await aceptaciones(a.regla)).length).toBe(2);
    expect(await aceptaciones(b.regla)).toEqual([]);
  });

  it("descarga en un periodo ya revisado (014 DU-21): la fila no suma hasta que se reabra y se vuelva a revisar", async () => {
    const e = await escenario({ n: 2, estado: "revisado" });
    expect(await aceptaciones(e.regla), "aplicada sobre un periodo revisado").toEqual([]);
    await reabrir(e);
    await revisar(e);
    expect(await aceptaciones(e.regla)).toHaveLength(2);
  });

  it("el trigger corre aunque la app no tenga INSERT en regla_aceptacion (SECURITY DEFINER): el backend que revisa no puede insertar a mano", async () => {
    const e = await escenario({ n: 1 });
    const directo = await backend.withTenant({ tenantId: X, userId: ux }, async (tx) => {
      await tx.query("SAVEPOINT s");
      try {
        await tx.query(
          "insert into regla_aceptacion (regla_aplicacion_id, regla_id, periodo) select id, regla_id, periodo from regla_aplicacion where regla_id = $1",
          [e.regla],
        );
        return "ok";
      } catch (err) {
        await tx.query("ROLLBACK TO SAVEPOINT s");
        return String((err as { code?: string }).code);
      }
    });
    expect(directo).toBe("42501");
    await revisar(e);
    expect(await aceptaciones(e.regla)).toHaveLength(1);
  });
});

// =================================================================================================
describe("0049 · confirmaciones para el catalogo: solo RUC 20 con el aporte encendido (P-1, P-10, CA-6)", () => {
  it("RUC 20 con aporte por defecto: una confirmacion `aceptada` por fila aceptada, con regla, cliente, RUC del proveedor y destino", async () => {
    const e = await escenario({ n: 3, docNumero: "20622222222", destino: "DGNG" });
    await corregir(e, e.compras[2]!, 3, "DG");
    await revisar(e);
    const c = await confirmaciones(e.regla);
    expect(c).toEqual([
      { regla_id: e.regla, cliente_id: e.c.id, ruc_proveedor: "20622222222", destino: "DGNG", origen: "aceptada" },
      { regla_id: e.regla, cliente_id: e.c.id, ruc_proveedor: "20622222222", destino: "DGNG", origen: "aceptada" },
    ]);
  });

  it("aporte explicitamente encendido tambien registra", async () => {
    await ec.aporte(X, true);
    const e = await escenario({ n: 1 });
    await revisar(e);
    expect(await confirmaciones(e.regla)).toHaveLength(1);
  });

  it("RUC que empieza en 10 (persona natural): hay aceptacion y NO confirmacion", async () => {
    const e = await escenario({ n: 2, docNumero: "10733333333" });
    await revisar(e);
    expect(await aceptaciones(e.regla)).toHaveLength(2);
    expect(await confirmaciones(e.regla)).toEqual([]);
  });

  it("documento que no es RUC (DNI, tipo 1) aunque su numero empiece en 20: hay aceptacion y NO confirmacion", async () => {
    const e = await escenario({ n: 2, docTipo: "1", docNumero: "20444444" });
    await revisar(e);
    expect(await aceptaciones(e.regla)).toHaveLength(2);
    expect(await confirmaciones(e.regla)).toEqual([]);
  });

  it("aporte apagado en el estudio: hay aceptacion y NO confirmacion", async () => {
    const e = await escenario({ tenant: W, n: 2, docNumero: "20655555555" });
    await revisar(e);
    expect(await aceptaciones(e.regla)).toHaveLength(2);
    expect(await confirmaciones(e.regla)).toEqual([]);
  });

  it("apagar el aporte entre dos revisiones: la segunda no registra las que faltaban; encenderlo de nuevo si", async () => {
    const e = await escenario({ n: 2, docNumero: "20666666666" });
    await corregir(e, e.compras[1]!, 3, "DG");
    await revisar(e);
    expect(await confirmaciones(e.regla)).toHaveLength(1);
    await reabrir(e);
    await corregir(e, e.compras[1]!, 4, "DNG");
    await ec.aporte(X, false);
    try {
      await revisar(e);
      expect(await aceptaciones(e.regla), "la aceptacion si se registra").toHaveLength(2);
      expect(await confirmaciones(e.regla), "la confirmacion no").toHaveLength(1);
    } finally {
      await ec.aporte(X, true);
    }
  });

  it("reabrir y revisar de nuevo no duplica confirmaciones", async () => {
    const e = await escenario({ n: 2, docNumero: "20677777777" });
    await revisar(e);
    await reabrir(e);
    await revisar(e);
    expect(await aceptaciones(e.regla)).toHaveLength(2);
    expect(await confirmaciones(e.regla)).toHaveLength(2);
  });

  it("las confirmaciones son del estudio de la regla (un estudio no recibe las del otro) y la app no las lee", async () => {
    const e = await escenario({ n: 1, docNumero: "20688888888" });
    await revisar(e);
    const r = await admin.query("select tenant_id from regla_confirmacion where regla_id = $1", [e.regla]);
    expect(r.rows.map((x) => x.tenant_id)).toEqual([X]);
    for (const [db, tenant] of [
      [backend, X],
      [backend, W],
      [worker, X],
    ] as const) {
      const intento = await db.withTenant({ tenantId: tenant }, async (tx) => {
        await tx.query("SAVEPOINT s");
        try {
          await tx.query("select 1 from regla_confirmacion");
          return "ok";
        } catch (err) {
          await tx.query("ROLLBACK TO SAVEPOINT s");
          return String((err as { code?: string }).code);
        }
      });
      expect(intento).toBe("42501");
    }
  });

  it("las confirmaciones no llevan montos, razon social ni usuario (solo estudio, cliente, RUC del proveedor, destino, origen y fecha)", async () => {
    const cols = (
      await admin.query("select column_name from information_schema.columns where table_name = 'regla_confirmacion'")
    ).rows.map((x) => x.column_name as string);
    expect(cols, "falta regla_confirmacion").not.toHaveLength(0);
    expect(cols.filter((c) => /usuario|razon|monto|bi_|igv|total|nombre/.test(c))).toEqual([]);
  });
});

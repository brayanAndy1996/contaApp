// Spec 021 · T25c (a), rojo hasta la migracion 0052. `aplicar_reglas_historial(p_items jsonb)` aplica R-HIS por lotes de hasta
// 500 compras con las MISMAS validaciones y el mismo fallo cerrado (42501) que `aplicar_regla_historial` (0048/0050), que se
// conserva. Contrato que fijan estas pruebas:
//   public.aplicar_reglas_historial(p_items jsonb) -> integer (cuantas versiones `historial` creo = cardinalidad del lote)
//     p_items = arreglo jsonb de 1 a 500 objetos {compra: uuid, regla: uuid, datos: <p_datos de aplicar_regla_historial>}.
//     SECURITY DEFINER de contapp_migrator, search_path fijo, EXECUTE solo contapp_worker.
//   Semantica del lote: TODO O NADA. Una sola fila invalida rechaza el lote entero con 42501 y no deja aplicada ninguna fila
//   (como la funcion por fila: su 42501 aborta la transaccion y la descarga entera se revierte; nunca siguen las validas).
//   La auditoria `compra.historial` sigue con una fila por compra (mismo actor, entidad y datos), insertada por sentencia.
//   `insertarCompras(..., { historial })` (packages/db) aplica por lotes de 500.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { abrirAdmin, exportado } from "./auth-soporte";
import { abrirPool, intentar, intentarRaw, type ContappDb, type Tx } from "./soporte";
import { codigo, crearDb, type ClientePrueba } from "./trabajos-soporte";
import {
  claveCompra,
  evaluadorFalso,
  type CompraLeida,
  type Evaluar,
  type IdentidadCompra,
  type Montos,
} from "./compras-soporte";
import {
  aplicar,
  compraDelWorker,
  consolidar,
  datosJson,
  DESCARGA,
  EscenarioReglas,
  FACTURA_DG,
  MIXTA,
  MIXTA_CHICA,
  montos,
  montosDeFila,
  uuidNuevo,
  type Destino,
} from "./reglas-soporte";

const FUNCION = "aplicar_reglas_historial";
const SQL_LOTE = "select public.aplicar_reglas_historial($1::jsonb) as n";

let admin: Pool;
let app: Pool;
let ec: EscenarioReglas;
let worker: ContappDb;
let backend: ContappDb;
let X: string;
let Y: string;
let Z: string; // R-HIS apagado
let cx: ClientePrueba;
let cx2: ClientePrueba;
let cy: ClientePrueba;
let cz: ClientePrueba;
let ux: string;
let propX: string;
let propY: string;
let propZ: string;
let trabajoX: string;
let errSiembra: unknown;

beforeAll(async () => {
  admin = abrirAdmin(8);
  app = abrirPool(2);
  ec = new EscenarioReglas(admin);
  X = (await ec.estudio()).id;
  Y = (await ec.estudio()).id;
  Z = (await ec.estudio()).id;
  cx = await ec.cliente(X);
  cx2 = await ec.cliente(X);
  cy = await ec.cliente(Y);
  cz = await ec.cliente(Z);
  ux = await ec.usuarioDe(X);
  worker = crearDb("contapp_worker", 4);
  backend = crearDb("contapp_backend", 2);
  propX = await ec.propuesta(X, cx, { libro: "compras", periodo: DESCARGA, nuevas: 50 });
  propY = await ec.propuesta(Y, cy, { libro: "compras", periodo: DESCARGA, nuevas: 50 });
  propZ = await ec.propuesta(Z, cz, { libro: "compras", periodo: DESCARGA, nuevas: 50 });
  trabajoX = await ec.trabajo(X, cx, ux);
  try {
    await ec.interruptor(Z, "R-HIS", false);
  } catch (e) {
    errSiembra = e;
  }
}, 60_000);
beforeEach(() => {
  if (errSiembra) throw errSiembra;
});
afterAll(async () => {
  await ec?.limpiar();
  await Promise.all([worker?.close(), backend?.close(), ec?.cerrar()].map((p) => p?.catch(() => undefined)));
  await app?.end();
  await admin?.end();
});

let consecutivo = 0;
const numero = () => String(9000 + ++consecutivo);
const docNuevo = () => `2${String(600000000 + ++consecutivo).padStart(10, "0")}`;

interface Item {
  compra: string;
  regla: string;
  datos: unknown;
}
const item = (compra: string, regla: string, m: Montos, destino: Destino): Item => ({
  compra,
  regla,
  datos: datosJson(consolidar(m, destino)),
});

async function lote(tx: Tx, items: unknown): Promise<number> {
  const r = await tx.query(SQL_LOTE, [JSON.stringify(items)]);
  return Number(r.rows[0].n);
}

/** Ejecuta `hacer` dentro de un SAVEPOINT que SIEMPRE se revierte; devuelve 'ok' o el SQLSTATE. */
async function enSavepoint(tx: Tx, hacer: () => Promise<unknown>): Promise<string> {
  await tx.query("SAVEPOINT t25c");
  try {
    await hacer();
    return "ok";
  } catch (e) {
    // Los envoltorios de @contapp/db traducen el error de PG a `codigo`.
    const x = e as { code?: string; codigo?: string };
    return String(x.code ?? x.codigo ?? "sin_codigo");
  } finally {
    await tx.query("ROLLBACK TO SAVEPOINT t25c");
  }
}

const nuevaCompra = (tx: Tx, doc: string, m: Montos = FACTURA_DG, o: { cliente?: ClientePrueba; propuesta?: string; periodo?: string; docTipo?: string } = {}) =>
  compraDelWorker(tx, (o.cliente ?? cx).id, o.propuesta ?? propX, o.periodo ?? DESCARGA, {
    numero: numero(),
    docNumero: doc,
    docTipo: o.docTipo,
    montos: m,
  });

/** Dos compras validas (con su regla) dentro de la `tx`: el lote las aplicaria si no fuera por la invalida. */
async function validas(tx: Tx, tenant = X, cliente = cx, propuesta = propX): Promise<Item[]> {
  const salida: Item[] = [];
  for (const [m, d] of [[FACTURA_DG, "DNG"], [MIXTA, "DGNG"]] as const) {
    const doc = docNuevo();
    const regla = await ec.regla(tenant, cliente, { docNumero: doc, destino: d });
    salida.push(item(await nuevaCompra(tx, doc, m, { cliente, propuesta }), regla, m, d));
  }
  return salida;
}

interface Comparacion {
  lote: string;
  fila: string | null;
  soloValidas: string;
  validas: string[];
}

/**
 * Prepara (dentro de una transaccion del worker que se CONFIRMA) dos compras validas y un item invalido, y compara:
 *   lote        el lote [valida, invalida, valida] (en un savepoint revertido);
 *   fila        la funcion por fila sobre la misma lista en el mismo orden (savepoint revertido), o null si no aplica;
 *   soloValidas el lote solo con las validas (savepoint revertido): prueba que lo unico que las frena es la invalida.
 * Tras confirmar, las validas no tienen version 2, ni regla_aplicacion, ni compra.historial (se comprueba con el superusuario).
 */
async function compararRechazo(
  preparar: (tx: Tx, v: Item[]) => Promise<{ invalido: unknown; porFila?: boolean }>,
  tenant = X,
): Promise<Comparacion> {
  let salida: Comparacion | undefined;
  const cliente = tenant === X ? cx : tenant === Y ? cy : cz;
  const propuesta = tenant === X ? propX : tenant === Y ? propY : propZ;
  await worker.withTenant({ tenantId: tenant }, async (tx) => {
    const v = await validas(tx, tenant, cliente, propuesta);
    const p = await preparar(tx, v);
    const lista = [v[0], p.invalido, v[1]];
    const loteR = await enSavepoint(tx, () => lote(tx, lista));
    const fila =
      p.porFila === false
        ? null
        : await enSavepoint(tx, async () => {
            for (const i of lista as Item[]) await aplicarCrudo(tx, i);
          });
    const soloValidas = await enSavepoint(tx, async () => {
      expect(await lote(tx, v)).toBe(2);
    });
    salida = { lote: loteR, fila, soloValidas, validas: v.map((x) => x.compra) };
  });
  const c = salida!;
  for (const id of c.validas) {
    const r = await admin.query(
      `select (select count(*)::int from compra_version where compra_id = $1) as versiones,
              (select version_vigente from compra where id = $1) as vigente,
              (select count(*)::int from regla_aplicacion where compra_id = $1) as aplicaciones,
              (select count(*)::int from auditoria where accion = 'compra.historial' and datos ->> 'compraId' = $1::text) as auditoria`,
      [id],
    );
    expect(r.rows[0], "la valida del lote rechazado queda sin aplicar").toEqual({ versiones: 1, vigente: 1, aplicaciones: 0, auditoria: 0 });
  }
  return c;
}

/** La funcion por fila con el `p_datos` del item tal cual (sin pasar por datosJson). */
async function aplicarCrudo(tx: Tx, i: Item): Promise<number> {
  const r = await tx.query("select public.aplicar_regla_historial($1, $2, $3::jsonb) as n", [i.compra, i.regla, JSON.stringify(i.datos)]);
  return Number(r.rows[0].n);
}

// =================================================================================================
describe("0052 · propiedades de aplicar_reglas_historial (patron de 0048)", () => {
  it("SECURITY DEFINER de contapp_migrator, search_path fijo, EXECUTE solo para contapp_worker; la funcion por fila sigue", async () => {
    const r = await admin.query(
      `select p.prosecdef, o.rolname as dueno, p.proconfig, p.oid::regprocedure::text as firma
         from pg_proc p join pg_roles o on o.oid = p.proowner
         join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
        where p.proname = $1`,
      [FUNCION],
    );
    expect(r.rows, "falta la funcion (migracion 0052)").toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ prosecdef: true, dueno: "contapp_migrator", firma: "aplicar_reglas_historial(jsonb)" });
    expect((r.rows[0].proconfig as string[]).join(" ")).toMatch(/search_path=pg_catalog, pg_temp/);
    const ejecutan = await admin.query(
      `select r.rolname from pg_roles r where r.rolname like 'contapp\\_%' and r.rolname <> 'contapp_migrator'
          and has_function_privilege(r.oid, 'public.aplicar_reglas_historial(jsonb)'::regprocedure, 'EXECUTE') order by 1`,
    );
    expect(ejecutan.rows.map((x) => x.rolname)).toEqual(["contapp_worker"]);
    expect(
      (await admin.query("select has_function_privilege(0::oid, 'public.aplicar_reglas_historial(jsonb)'::regprocedure, 'EXECUTE') as v")).rows[0].v,
      "PUBLIC ejecuta",
    ).toBe(false);
    expect(
      (await admin.query("select count(*)::int as n from pg_proc where proname = 'aplicar_regla_historial'")).rows[0].n,
      "la funcion por fila se conserva",
    ).toBe(1);
  });

  it("interno.auditoria_insertar_lote: dueño contapp_registrador, search_path fijo, EXECUTE solo contapp_migrator; el trigger es por sentencia", async () => {
    const firma = "interno.auditoria_insertar_lote(uuid,text,uuid,uuid,text,text,uuid[],uuid[],jsonb[])";
    const r = await admin.query(
      `select p.prosecdef, pg_get_userbyid(p.proowner) as dueno, p.proconfig,
              coalesce((select array_agg(x.rolname::text order by x.rolname) from pg_roles x
                         where x.oid <> p.proowner and x.rolname like 'contapp\\_%'
                           and has_function_privilege(x.oid, p.oid, 'EXECUTE')), '{}') as ejecutan,
              has_function_privilege(0::oid, p.oid, 'EXECUTE') as publico
         from pg_proc p where p.oid = $1::regprocedure`,
      [firma],
    );
    expect(r.rows).toEqual([
      { prosecdef: true, dueno: "contapp_registrador", proconfig: ["search_path=pg_catalog, pg_temp"], ejecutan: ["contapp_migrator"], publico: false },
    ]);
    for (const rol of ["contapp_worker", "contapp_backend"]) {
      const x = await intentarRaw(app, rol, `select interno.auditoria_insertar_lote($1::uuid, 'sistema', null, null, 'compra.historial', 'regla_aplicacion', '{}', '{}', '{}')`, [X]);
      expect(x.ok ? "ok" : x.code, rol).toBe("42501");
    }
    const t = await admin.query(
      "select tgtype::int as t from pg_trigger where tgname = 'auditoria_regla_aplicacion' and tgrelid = 'public.regla_aplicacion'::regclass",
    );
    expect(t.rows.map((x) => [x.t & 1, x.t & 2, x.t & 4]), "AFTER INSERT FOR EACH STATEMENT").toEqual([[0, 0, 4]]);
  });

  it("el backend no la ejecuta (42501), ni con un lote valido", async () => {
    const doc = docNuevo();
    const regla = await ec.regla(X, cx, { docNumero: doc });
    const compra = (await ec.compra(X, cx, { periodo: DESCARGA, propuestaId: propX, docNumero: doc })).id;
    const r = await intentar(backend, { tenantId: X, userId: ux }, SQL_LOTE, [JSON.stringify([item(compra, regla, FACTURA_DG, "DNG")])]);
    expect(codigo(r)).toBe("42501");
  });

  it("sin estudio en la sesion (sin app.tenant_id): 42501", async () => {
    const r = await intentarRaw(app, "contapp_worker", SQL_LOTE, [
      JSON.stringify([{ compra: uuidNuevo(), regla: uuidNuevo(), datos: datosJson(consolidar(FACTURA_DG, "DNG")) }]),
    ]);
    expect(r.ok ? "ok" : r.code).toBe("42501");
  });
});

// =================================================================================================
describe("0052 · equivalencia: el lote deja exactamente lo mismo que la funcion fila a fila", () => {
  const CASOS: [string, Montos, Destino][] = [
    ["factura gravada a DNG", FACTURA_DG, "DNG"],
    ["factura gravada a DGNG", FACTURA_DG, "DGNG"],
    ["mixta 600/400 a DG", MIXTA, "DG"],
    ["mixta 21.48/1.61 con no gravado a DNG", MIXTA_CHICA, "DNG"],
    ["con ISC, ICBPER y otros tributos a DGNG", montos({ biDg: "770.00", igvDg: "138.60", isc: "12.34", icbper: "0.50", otrosTributos: "1.10", noGravado: "5.00" }), "DGNG"],
    ["en DNG a DG", montos({ biDng: "50.00", igvDng: "9.00", noGravado: "1.00" }), "DG"],
    ["nota de credito (negativa) a DNG", montos({ biDg: "-100.00", igvDg: "-18.00" }), "DNG"],
    ["tope de NUMERIC(14,2) repartido a DGNG", montos({ biDg: "499999999999.99", biDng: "499999999999.99", total: "999999999999.98" }), "DGNG"],
  ];

  type Normalizado = {
    versiones: unknown[][];
    vigentes: number[];
    aplicaciones: unknown[];
    auditoria: unknown[];
  };

  async function correr(modo: "fila" | "lote", trabajoId?: string): Promise<Normalizado> {
    const docs = CASOS.map(() => docNuevo());
    const reglas: string[] = [];
    for (let i = 0; i < CASOS.length; i++) reglas.push(await ec.regla(X, cx, { docNumero: docs[i], destino: CASOS[i]![2] }));
    const { filas, resultado: compras } = await ec.capturar(X, "compra.historial", () =>
      worker.withTenant({ tenantId: X, ...(trabajoId ? { trabajoId } : {}) }, async (tx) => {
        const ids: string[] = [];
        for (let i = 0; i < CASOS.length; i++) ids.push(await nuevaCompra(tx, docs[i]!, CASOS[i]![1]));
        // Una compra mas sin regla: ninguna de las dos formas la toca.
        ids.push(await nuevaCompra(tx, docNuevo()));
        const items = CASOS.map(([, m, d], i) => item(ids[i]!, reglas[i]!, m, d));
        if (modo === "fila") {
          for (const i of items) expect(await aplicarCrudo(tx, i)).toBe(2);
        } else {
          expect(await lote(tx, items)).toBe(CASOS.length);
        }
        return ids;
      }),
    );
    const idx = (m: string[], v: unknown) => m.indexOf(v as string);
    const versiones: unknown[][] = [];
    const vigentes: number[] = [];
    for (const id of compras) {
      const v = await admin.query(
        `select n, bi_dg, igv_dg, bi_dgng, igv_dgng, bi_dng, igv_dng, no_gravado, isc, icbper, otros_tributos, total,
                excluida, motivo, clasificada, accion, operacion_id, usuario_id
           from compra_version where compra_id = $1 order by n`,
        [id],
      );
      versiones.push(v.rows);
      vigentes.push((await admin.query("select version_vigente from compra where id = $1", [id])).rows[0].version_vigente as number);
    }
    const ap = await admin.query(
      "select id, regla_id, compra_id, version_n, periodo from regla_aplicacion where compra_id = any($1::uuid[])",
      [compras],
    );
    const idsAp = ap.rows.map((r) => r.id as string);
    const aplicaciones = ap.rows
      .map((r) => ({ regla: idx(reglas, r.regla_id), compra: idx(compras, r.compra_id), version_n: r.version_n, periodo: r.periodo }))
      .sort((a, b) => a.compra - b.compra);
    const auditoria = filas
      .map((f) => ({
        accion: f.accion,
        actor: f.actor_tipo,
        usuario: f.usuario_id,
        trabajo: f.trabajo_id,
        cliente: f.cliente_id,
        entidad: f.entidad,
        entidadEsSuAplicacion: idsAp.includes(f.entidad_id as string) &&
          ap.rows.find((r) => r.id === f.entidad_id)!.compra_id === (f.datos as { compraId: string }).compraId,
        datos: {
          compraId: idx(compras, (f.datos as { compraId: string }).compraId),
          reglaId: idx(reglas, (f.datos as { reglaId: string }).reglaId),
          periodo: (f.datos as { periodo: string }).periodo,
          claves: Object.keys(f.datos as object).sort(),
        },
      }))
      .sort((a, b) => a.datos.compraId - b.datos.compraId);
    return { versiones, vigentes, aplicaciones, auditoria };
  }

  for (const [actor, conTrabajo] of [["sistema", false], ["trabajo", true]] as const) {
    it(`actor ${actor}: versiones, puntero, regla_aplicacion, montos y auditoria identicos`, async () => {
      const t = conTrabajo ? trabajoX : undefined;
      const porFila = await correr("fila", t);
      const porLote = await correr("lote", t);
      expect(porLote).toEqual(porFila);
      // Y no son iguales por estar las dos mal: lo esperado, explicito.
      CASOS.forEach(([, m, d], i) => {
        expect(porLote.versiones[i]!.map((r) => (r as { n: number }).n)).toEqual([1, 2]);
        expect(montosDeFila(porLote.versiones[i]![0] as Record<string, string>)).toEqual(m);
        expect(montosDeFila(porLote.versiones[i]![1] as Record<string, string>)).toEqual(consolidar(m, d));
        expect(porLote.versiones[i]![1]).toMatchObject({ accion: "historial", clasificada: true, excluida: false, operacion_id: null, usuario_id: null });
      });
      expect(porLote.versiones[CASOS.length]!.map((r) => (r as { n: number }).n), "la compra sin regla").toEqual([1]);
      expect(porLote.vigentes).toEqual([...CASOS.map(() => 2), 1]);
      expect(porLote.aplicaciones).toEqual(CASOS.map((_, i) => ({ regla: i, compra: i, version_n: 2, periodo: DESCARGA })));
      expect(porLote.auditoria).toEqual(
        CASOS.map((_, i) => ({
          accion: "compra.historial",
          actor,
          usuario: conTrabajo ? ux : null,
          trabajo: conTrabajo ? trabajoX : null,
          cliente: cx.id,
          entidad: "regla_aplicacion",
          entidadEsSuAplicacion: true,
          datos: { compraId: i, reglaId: i, periodo: DESCARGA, claves: ["compraId", "periodo", "reglaId"] },
        })),
      );
    });
  }

  it("un lote de 500 se aplica entero; 501 se rechaza (42501) sin aplicar nada", async () => {
    const doc = docNuevo();
    const regla = await ec.regla(X, cx, { docNumero: doc, destino: "DNG" });
    const r = await worker.withTenant({ tenantId: X }, async (tx) => {
      const items: Item[] = [];
      for (let i = 0; i < 501; i++) items.push(item(await nuevaCompra(tx, doc), regla, FACTURA_DG, "DNG"));
      const de501 = await enSavepoint(tx, () => lote(tx, items));
      const de500 = await lote(tx, items.slice(0, 500));
      const vigentes = await tx.query("select version_vigente as v, count(*)::int as n from compra where id = any($1::uuid[]) group by 1 order by 1", [
        items.map((i) => i.compra),
      ]);
      return { de501, de500, vigentes: vigentes.rows };
    });
    expect(r.de501).toBe("42501");
    expect(r.de500).toBe(500);
    expect(r.vigentes).toEqual([{ v: 1, n: 1 }, { v: 2, n: 500 }]);
    expect((await admin.query("select count(*)::int as n from regla_aplicacion where regla_id = $1", [regla])).rows[0].n).toBe(500);
    expect(
      (await admin.query("select count(*)::int as n from auditoria where accion = 'compra.historial' and datos ->> 'reglaId' = $1::text", [regla])).rows[0].n,
      "una fila de auditoria por compra",
    ).toBe(500);
  }, 60_000);

  it("varias compras de la misma regla en un lote: una version y una aplicacion por compra", async () => {
    const doc = docNuevo();
    const regla = await ec.regla(X, cx, { docNumero: doc, destino: "DGNG" });
    const ids = await worker.withTenant({ tenantId: X }, async (tx) => {
      const ids = [await nuevaCompra(tx, doc), await nuevaCompra(tx, doc, MIXTA), await nuevaCompra(tx, doc, MIXTA_CHICA)];
      expect(await lote(tx, [item(ids[0]!, regla, FACTURA_DG, "DGNG"), item(ids[1]!, regla, MIXTA, "DGNG"), item(ids[2]!, regla, MIXTA_CHICA, "DGNG")])).toBe(3);
      return ids;
    });
    const r = await admin.query("select compra_id, version_n from regla_aplicacion where regla_id = $1 order by compra_id", [regla]);
    expect(r.rows).toEqual([...ids].sort().map((id) => ({ compra_id: id, version_n: 2 })));
  });
});

// =================================================================================================
describe("0052 · un item invalido rechaza el LOTE ENTERO (42501), igual que la funcion por fila rechaza la descarga", () => {
  const conRegla = async (o: Parameters<EscenarioReglas["regla"]>[2] = {}) => {
    const doc = o.docNumero ?? docNuevo();
    return { doc, regla: await ec.regla(X, cx, { docNumero: doc, ...o }) };
  };
  type Caso = [string, (tx: Tx, v: Item[]) => Promise<{ invalido: unknown; porFila?: boolean }>];
  const CASOS: Caso[] = [
    ["compra no creada en esta transaccion (existia antes)", async () => {
      const { doc, regla } = await conRegla();
      const previa = (await ec.compra(X, cx, { periodo: DESCARGA, propuestaId: propX, docNumero: doc })).id;
      return { invalido: item(previa, regla, FACTURA_DG, "DNG") };
    }],
    ["compra que ya tiene la version 2 (aplicada antes en la transaccion)", async (tx) => {
      const { doc, regla } = await conRegla();
      const c = await nuevaCompra(tx, doc);
      await aplicar(tx, c, regla, consolidar(FACTURA_DG, "DNG"));
      return { invalido: item(c, regla, FACTURA_DG, "DNG") };
    }],
    ["la misma compra dos veces en el lote (un solo historial por compra)", async (_tx, v) => ({ invalido: v[0] })],
    ["compra de otro estudio (invisible por RLS)", async () => {
      const doc = docNuevo();
      const regla = await ec.regla(X, cx, { docNumero: doc });
      const ajena = (await ec.compra(Y, cy, { periodo: DESCARGA, propuestaId: propY, docNumero: doc })).id;
      return { invalido: item(ajena, regla, FACTURA_DG, "DNG") };
    }],
    ["compra inexistente", async () => {
      const { regla } = await conRegla();
      return { invalido: item(uuidNuevo(), regla, FACTURA_DG, "DNG") };
    }],
    ["regla de otro cliente del mismo estudio", async (tx) => {
      const doc = docNuevo();
      const regla = await ec.regla(X, cx2, { docNumero: doc });
      return { invalido: item(await nuevaCompra(tx, doc), regla, FACTURA_DG, "DNG") };
    }],
    ["regla de otro estudio", async (tx) => {
      const doc = docNuevo();
      const regla = await ec.regla(Y, cy, { docNumero: doc });
      return { invalido: item(await nuevaCompra(tx, doc), regla, FACTURA_DG, "DNG") };
    }],
    ["regla inexistente", async (tx) => ({ invalido: item(await nuevaCompra(tx, docNuevo()), uuidNuevo(), FACTURA_DG, "DNG") })],
    ["regla de otro proveedor (otro numero)", async (tx) => {
      const { regla } = await conRegla();
      return { invalido: item(await nuevaCompra(tx, docNuevo()), regla, FACTURA_DG, "DNG") };
    }],
    ["regla de otro tipo de documento", async (tx) => {
      const { doc, regla } = await conRegla();
      return { invalido: item(await nuevaCompra(tx, doc, FACTURA_DG, { docTipo: "1" }), regla, FACTURA_DG, "DNG") };
    }],
    ["regla inactiva", async (tx) => {
      const { doc, regla } = await conRegla({ activa: false });
      return { invalido: item(await nuevaCompra(tx, doc), regla, FACTURA_DG, "DNG") };
    }],
    ["regla eliminada", async (tx) => {
      const { doc, regla } = await conRegla({ eliminada: true });
      return { invalido: item(await nuevaCompra(tx, doc), regla, FACTURA_DG, "DNG") };
    }],
    ["regla aprendida en el mismo periodo de la compra (P-5)", async (tx) => {
      const { doc, regla } = await conRegla({ periodoAprendido: DESCARGA });
      return { invalido: item(await nuevaCompra(tx, doc), regla, FACTURA_DG, "DNG") };
    }],
    ["regla aprendida despues del periodo de la compra (P-5)", async (tx) => {
      const { doc, regla } = await conRegla({ periodoAprendido: "202611" });
      return { invalido: item(await nuevaCompra(tx, doc), regla, FACTURA_DG, "DNG") };
    }],
    ["base gravada 0 (solo no gravado)", async (tx) => {
      const m = montos({ noGravado: "100.00" });
      const { doc, regla } = await conRegla();
      return { invalido: item(await nuevaCompra(tx, doc, m), regla, m, "DNG") };
    }],
    ["nada que cambie (la version 1 ya esta en el destino)", async (tx) => {
      const m = montos({ biDng: "100.00", igvDng: "18.00" });
      const { doc, regla } = await conRegla({ destino: "DNG" });
      return { invalido: item(await nuevaCompra(tx, doc, m), regla, m, "DNG") };
    }],
    ["datos consolidados en otro destino", async (tx) => {
      const { doc, regla } = await conRegla({ destino: "DNG" });
      return { invalido: item(await nuevaCompra(tx, doc), regla, FACTURA_DG, "DG") };
    }],
    ["datos de la version 1 sin consolidar", async (tx) => {
      const { doc, regla } = await conRegla({ destino: "DNG" });
      return { invalido: { compra: await nuevaCompra(tx, doc), regla, datos: datosJson(FACTURA_DG) } };
    }],
    ["total alterado en un centimo", async (tx) => {
      const { doc, regla } = await conRegla({ destino: "DNG" });
      const i = item(await nuevaCompra(tx, doc), regla, FACTURA_DG, "DNG");
      return { invalido: { ...i, datos: { ...(i.datos as object), total: "1180.01" } } };
    }],
    ["datos sin una columna", async (tx) => {
      const { doc, regla } = await conRegla({ destino: "DNG" });
      const i = item(await nuevaCompra(tx, doc), regla, FACTURA_DG, "DNG");
      const { isc: _isc, ...resto } = i.datos as Record<string, string>;
      return { invalido: { ...i, datos: resto } };
    }],
    ["datos con una columna de mas", async (tx) => {
      const { doc, regla } = await conRegla({ destino: "DNG" });
      const i = item(await nuevaCompra(tx, doc), regla, FACTURA_DG, "DNG");
      return { invalido: { ...i, datos: { ...(i.datos as object), extra: "0.00" } } };
    }],
    ["datos con un numero en vez de cadena", async (tx) => {
      const { doc, regla } = await conRegla({ destino: "DNG" });
      const i = item(await nuevaCompra(tx, doc), regla, FACTURA_DG, "DNG");
      return { invalido: { ...i, datos: { ...(i.datos as object), isc: 0 } } };
    }],
    ["datos con formato no decimal (1e3, tres decimales)", async (tx) => {
      const { doc, regla } = await conRegla({ destino: "DNG" });
      const i = item(await nuevaCompra(tx, doc), regla, FACTURA_DG, "DNG");
      return { invalido: { ...i, datos: { ...(i.datos as object), bi_dng: "1e3", isc: "0.000" } } };
    }],
    ["datos nulos o que no son un objeto", async (tx) => {
      const { doc, regla } = await conRegla({ destino: "DNG" });
      return { invalido: { compra: await nuevaCompra(tx, doc), regla, datos: [] } };
    }],
  ];
  for (const [nombre, preparar] of CASOS) {
    it(`${nombre}: lote 42501 sin aplicar ninguna fila; fila a fila tambien 42501`, async () => {
      const c = await compararRechazo(preparar);
      expect(c.lote, "lote").toBe("42501");
      expect(c.fila, "fila a fila").toBe("42501");
      expect(c.soloValidas, "las validas solas se aplican").toBe("ok");
    });
  }

  // Items mal formados: no tienen equivalente por fila (la funcion por fila recibe uuid tipados).
  const MALFORMADOS: [string, (v: Item[]) => unknown][] = [
    ["compra que no es uuid", (v) => ({ ...v[0], compra: "no-es-uuid" })],
    ["regla nula", (v) => ({ ...v[0], regla: null })],
    ["sin datos", (v) => ({ compra: v[0]!.compra, regla: v[0]!.regla })],
    ["clave de mas en el item", (v) => ({ ...v[1], tenant: Y })],
    ["item que no es un objeto", () => "x"],
    ["item nulo", () => null],
  ];
  for (const [nombre, invalido] of MALFORMADOS) {
    it(`item mal formado (${nombre}): lote 42501 sin aplicar ninguna fila`, async () => {
      const c = await compararRechazo(async (_tx, v) => ({ invalido: invalido(v), porFila: false }));
      expect(c.lote).toBe("42501");
      expect(c.soloValidas).toBe("ok");
    });
  }

  it("p_items nulo, vacio, que no es un arreglo o un objeto suelto: 42501", async () => {
    for (const p of [null, [], {}, "x", 5]) {
      const r = await worker.withTenant({ tenantId: X }, (tx) => enSavepoint(tx, () => lote(tx, p)));
      expect(r, JSON.stringify(p)).toBe("42501");
    }
  });

  it("R-HIS apagado en el estudio: 42501 para el lote entero (igual que por fila); encendido, se aplica", async () => {
    const r = await worker.withTenant({ tenantId: Z }, async (tx) => {
      const v = await validas(tx, Z, cz, propZ);
      return { lote: await enSavepoint(tx, () => lote(tx, v)), fila: await enSavepoint(tx, () => aplicarCrudo(tx, v[0]!)) };
    });
    expect(r).toEqual({ lote: "42501", fila: "42501" });
    await ec.interruptor(Z, "R-HIS", true);
    try {
      const n = await worker.withTenant({ tenantId: Z }, async (tx) => {
        const v = await validas(tx, Z, cz, propZ);
        return enSavepoint(tx, () => lote(tx, v));
      });
      expect(n).toBe("ok");
    } finally {
      await ec.interruptor(Z, "R-HIS", false);
    }
  });

  it("app.trabajo_id de otro estudio: la auditoria rechaza (42501) el lote entero, igual que por fila", async () => {
    const ajeno = await ec.trabajo(Y, cy, null);
    const doc = docNuevo();
    const regla = await ec.regla(X, cx, { docNumero: doc });
    const r = await worker.withTenant({ tenantId: X, trabajoId: ajeno }, async (tx) => {
      const compra = await nuevaCompra(tx, doc);
      const i = item(compra, regla, FACTURA_DG, "DNG");
      return { lote: await enSavepoint(tx, () => lote(tx, [i])), fila: await enSavepoint(tx, () => aplicarCrudo(tx, i)) };
    });
    expect(r).toEqual({ lote: "42501", fila: "42501" });
  });

  it("toma el candado compartido 'reglas_motor' del estudio: con el exclusivo tomado (PUT del interruptor) espera", async () => {
    const c = await admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("select pg_advisory_xact_lock(hashtextextended('reglas_motor:' || $1::text, 0))", [X]);
      const doc = docNuevo();
      const regla = await ec.regla(X, cx, { docNumero: doc });
      const r = await worker.withTenant({ tenantId: X }, async (tx) => {
        const compra = await nuevaCompra(tx, doc);
        await tx.query("SET LOCAL lock_timeout = '300ms'");
        return enSavepoint(tx, () => lote(tx, [item(compra, regla, FACTURA_DG, "DNG")]));
      });
      expect(r).toBe("55P03");
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  });
});

// =================================================================================================
describe("insertarCompras con `historial` aplica por lotes de 500 · packages/db", () => {
  type Nueva = IdentidadCompra & { montos: Montos };
  type Historial = (f: CompraLeida) => { reglaId: string; datos: Montos } | null;
  const insertarCompras = (
    tx: Tx,
    ctx: { clienteId: string; periodo: string; propuestaId: string },
    nuevas: Nueva[],
    f: { evaluar: Evaluar; historial?: Historial },
  ) => exportado<(tx: Tx, c: unknown, n: Nueva[], f: unknown) => Promise<string[]>>("insertarCompras")(tx, ctx, nuevas, f);
  const fila = (serie: string, num: string, docNumero: string, m: Montos = FACTURA_DG): Nueva => ({
    clave: claveCompra("01", serie, num, "6", docNumero),
    tipoDoc: "01",
    serie,
    numero: num,
    docTipo: "6",
    docNumero,
    razonSocial: "LOTE REGLAS SAC",
    fecha: "2026-10-05",
    moneda: "PEN",
    tipoCambio: null,
    montos: m,
  });

  it("1.001 compras (3 lotes) de dos proveedores con regla y una sin regla: versiones, aplicaciones y auditoria por compra", async () => {
    const [d1, d2, d3] = [docNuevo(), docNuevo(), docNuevo()];
    const r1 = await ec.regla(X, cx, { docNumero: d1, destino: "DNG" });
    const r2 = await ec.regla(X, cx, { docNumero: d2, destino: "DGNG" });
    const nuevas: Nueva[] = [];
    for (let i = 0; i < 1001; i++) nuevas.push(fila("L025", String(i + 1), i % 3 === 0 ? d1 : i % 3 === 1 ? d2 : d3, i % 2 ? MIXTA : FACTURA_DG));
    const destinoDe = new Map([[d1, ["DNG", r1]], [d2, ["DGNG", r2]]] as const);
    const e = evaluadorFalso();
    const { filas, resultado: ids } = await ec.capturar(X, "compra.historial", () =>
      worker.withTenant({ tenantId: X }, (tx) =>
        insertarCompras(tx, { clienteId: cx.id, periodo: DESCARGA, propuestaId: propX }, nuevas, {
          evaluar: e.evaluar,
          historial: (f) => {
            const d = destinoDe.get(f.docNumero as never);
            return d ? { reglaId: d[1], datos: consolidar(f.montos, d[0]) } : null;
          },
        }),
      ),
    );
    const conRegla = nuevas.filter((n) => n.docNumero !== d3).length;
    expect(ids).toHaveLength(1001);
    const v = await admin.query(
      `select c.doc_numero, c.version_vigente, count(v.*)::int as versiones,
              bool_and(v.n = 1 or (v.accion = 'historial' and v.clasificada)) as historial_ok
         from compra c join compra_version v on v.compra_id = c.id
        where c.id = any($1::uuid[]) group by c.id, c.doc_numero, c.version_vigente`,
      [ids],
    );
    for (const r of v.rows) {
      const aplica = r.doc_numero !== d3;
      expect([r.version_vigente, r.versiones, r.historial_ok], r.doc_numero).toEqual([aplica ? 2 : 1, aplica ? 2 : 1, true]);
    }
    const mal = await admin.query(
      `select count(*)::int as n from compra c join compra_version v1 on v1.compra_id = c.id and v1.n = 1
         join compra_version v2 on v2.compra_id = c.id and v2.n = 2
        where c.id = any($1::uuid[])
          and (v2.bi_dg + v2.bi_dgng + v2.bi_dng <> v1.bi_dg + v1.bi_dgng + v1.bi_dng or v2.total <> v1.total
               or (c.doc_numero = $2 and v2.bi_dng = 0) or (c.doc_numero = $3 and v2.bi_dgng = 0))`,
      [ids, d1, d2],
    );
    expect(mal.rows[0].n, "montos consolidados en el destino de su regla").toBe(0);
    expect((await admin.query("select count(*)::int as n from regla_aplicacion where compra_id = any($1::uuid[])", [ids])).rows[0].n).toBe(conRegla);
    expect(filas).toHaveLength(conRegla);
    expect(new Set(filas.map((f) => (f.datos as { compraId: string }).compraId)).size).toBe(conRegla);
    expect(e.llamadas.filter((f) => f.version === 2)).toHaveLength(conRegla);
    expect(e.llamadas.filter((f) => f.version === 1)).toHaveLength(1001);
  }, 120_000);

  it("si el lote rechaza una compra (datos que no son la consolidacion) toda la descarga se revierte", async () => {
    const d = docNuevo();
    const regla = await ec.regla(X, cx, { docNumero: d, destino: "DNG" });
    const nuevas = [fila("L026", "1", d), fila("L026", "2", d), fila("L026", "3", d)];
    let c = "ok";
    try {
      await worker.withTenant({ tenantId: X }, (tx) =>
        insertarCompras(tx, { clienteId: cx.id, periodo: DESCARGA, propuestaId: propX }, nuevas, {
          evaluar: evaluadorFalso().evaluar,
          historial: (f) => ({ reglaId: regla, datos: consolidar(f.montos, f.numero === "2" ? "DG" : "DNG") }),
        }),
      );
    } catch (e) {
      c = String((e as { code?: string; codigo?: string }).code ?? (e as { codigo?: string }).codigo);
    }
    expect(c).toBe("42501");
    expect((await admin.query("select count(*)::int as n from compra where cliente_id = $1 and serie = 'L026'", [cx.id])).rows[0].n).toBe(0);
  });
});


// =================================================================================================
describe("@contapp/db · aplicarReglaHistorial (por fila) y aplicarReglasHistorial (por lotes)", () => {
  type Aplicar1 = (tx: Tx, compraId: string, reglaId: string, datos: Montos) => Promise<number>;
  type AplicarN = (tx: Tx, items: { compraId: string; reglaId: string; datos: Montos }[]) => Promise<number>;

  it("las dos dejan la misma version 2; el lote devuelve cuantas creo y parte en lotes de LOTE_HISTORIAL (500)", async () => {
    expect(exportado<number>("LOTE_HISTORIAL")).toBe(500);
    const doc = docNuevo();
    const regla = await ec.regla(X, cx, { docNumero: doc, destino: "DGNG" });
    const r = await worker.withTenant({ tenantId: X }, async (tx) => {
      const uno = await nuevaCompra(tx, doc, MIXTA);
      const n1 = await exportado<Aplicar1>("aplicarReglaHistorial")(tx, uno, regla, consolidar(MIXTA, "DGNG"));
      const varias: string[] = [];
      for (let i = 0; i < 3; i++) varias.push(await nuevaCompra(tx, doc, MIXTA));
      const nN = await exportado<AplicarN>("aplicarReglasHistorial")(
        tx,
        varias.map((compraId) => ({ compraId, reglaId: regla, datos: consolidar(MIXTA, "DGNG") })),
      );
      const vacio = await exportado<AplicarN>("aplicarReglasHistorial")(tx, []);
      return { n1, nN, vacio, uno, varias };
    });
    expect([r.n1, r.nN, r.vacio]).toEqual([2, 3, 0]);
    const v = await admin.query(
      `select compra_id, bi_dg, bi_dgng, igv_dgng, total, accion from compra_version where compra_id = any($1::uuid[]) and n = 2`,
      [[r.uno, ...r.varias]],
    );
    expect(new Set(v.rows.map((x) => JSON.stringify([x.bi_dg, x.bi_dgng, x.igv_dgng, x.total, x.accion])))).toEqual(
      new Set([JSON.stringify(["0.00", "1000.00", "180.00", "1180.00", "historial"])]),
    );
    expect(v.rows).toHaveLength(4);
  });

  it("un rechazo en cualquiera de las dos es 42501", async () => {
    const doc = docNuevo();
    const regla = await ec.regla(X, cx, { docNumero: doc, destino: "DNG" });
    const r = await worker.withTenant({ tenantId: X }, async (tx) => {
      const c = await nuevaCompra(tx, doc);
      const fila = await enSavepoint(tx, () => exportado<Aplicar1>("aplicarReglaHistorial")(tx, c, regla, consolidar(FACTURA_DG, "DG")));
      const lote = await enSavepoint(tx, () =>
        exportado<AplicarN>("aplicarReglasHistorial")(tx, [{ compraId: c, reglaId: regla, datos: consolidar(FACTURA_DG, "DG") }]),
      );
      return { fila, lote };
    });
    expect(r).toEqual({ fila: "42501", lote: "42501" });
  });
});

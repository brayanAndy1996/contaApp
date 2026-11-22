import type { ContappDb } from "@contapp/db";
import { puntuarGastoPersonal } from "@contapp/domain";
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AlmacenEspia,
  ctxDe,
  encolarGenerar,
  huellaDe,
  limpiarArchivos,
  previoDe,
  sembrarComprasBase,
  type ParametrosGenerar,
} from "../../../test/archivos.js";
import {
  PERIODO,
  RUC_FIXTURE,
  comprasDe,
  descartarCompra,
  encolarDescarga,
  filaCompra,
  fijarEstadoPeriodo,
  limpiarCompras,
  mundoVentas,
  nuevaVersion,
  sembrarCompra,
  type MundoVentas,
} from "../../../test/compras.js";
import {
  ConsultaRucCiiu,
  arrancarConCiiu,
  cancelarPendientes,
  desactivarGlobal,
  exigirImplementado027,
  fijarCategorias,
  fijarUmbral,
  limpiarGastos,
  rgpDe,
  sembrarCiiu,
  sembrarPalabra,
  sembrarXmlSubido,
} from "../../../test/gastos.js";
import { esperarTerminal } from "../../../test/procesadores-007b.js";
import { espiarSentencias, transaccionDe } from "../../../test/prorrata.js";
import { limpiarReglas } from "../../../test/reglas.js";
import {
  Escenario,
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  esperarHasta,
  fijarConfig,
  limpiarPrefijo,
  nuevoPrefijo,
  restaurarConfig,
} from "../../../test/trabajos.js";
import { EMISORES, esperarLotesXml, evaluacionesDe, limpiarXml, puertosXml } from "../../../test/xml.js";
import { generarArchivo } from "../procesadores/generar-archivo.js";
import { contextoGastos } from "./contexto-gastos.js";

// Spec 027, T5 (rojo; integración con PostgreSQL y Redis reales): el contexto de R-GP del estudio, armado por un solo lector (D-5), llega
// a la descarga, al XML, a 012b y a «Volver a evaluar» (R-8; CA-1, CA-7, CA-10, CA-13).
//
// CONTRATO que fija (T11): `contextoGastos(tx, clienteId, periodo, proveedores)` devuelve el `ContextoGastos` del dominio
// (`{ diccionario, umbral, ciiuCliente, ciiuProveedores: [{ proveedor, ciiu }], categoriasCliente: { permitidas, quitadas },
// historial: [{ proveedor, aceptadas6, excluidas6, excluidas12 }] }`) con lo que lee `leerContextoGastos` de `packages/db` (solo
// lectura, ≤ 4 consultas) y el diccionario efectivo de `crearDiccionarioEfectivo`. La descarga (con el XML ya guardado del comprobante),
// el XML y 012b lo arman dentro de su transacción; 012b nunca bloquea por R-GP.

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

let admin: ContappDb;
let backend: ContappDb;
let dbWorker: ContappDb;
let redis: Redis;
let e: Escenario;
let prefijo = nuevoPrefijo();
const prefijos = [prefijo];
beforeEach(() => {
  prefijo = nuevoPrefijo();
  prefijos.push(prefijo);
});
afterEach(async () => {
  await cancelarPendientes(admin, e?.estudios ?? []);
});

beforeAll(async () => {
  admin = crearDbAdmin();
  backend = crearDbRol("contapp_backend");
  dbWorker = crearDbRol("contapp_worker", 8);
  redis = conectarRedis();
  e = new Escenario(admin);
  await exigirImplementado027(admin);
  await fijarConfig(admin, "sire", { global: 4, tenant: 2, espera: 0, reintentos: 1, base: 100 });
  await fijarConfig(admin, "xml", { global: 4, tenant: 2, espera: 0, reintentos: 1, base: 100 });
  await fijarConfig(admin, "archivos", { global: 4, tenant: 2, espera: 0, reintentos: 1, base: 100 });
});

afterAll(async () => {
  await restaurarConfig(admin).catch(() => undefined);
  await limpiarGastos(admin, e?.estudios ?? []).catch(() => undefined);
  await limpiarReglas(admin, e?.estudios ?? []).catch(() => undefined);
  await limpiarArchivos(admin, e?.estudios ?? []).catch(() => undefined);
  await limpiarXml(admin, e?.estudios ?? []).catch(() => undefined);
  await limpiarCompras(admin, e?.estudios ?? []).catch(() => undefined);
  await e?.limpiar();
  for (const x of prefijos) await limpiarPrefijo(redis, x).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([backend?.close(), dbWorker?.close(), admin?.close()]);
});

const mundo = (): Promise<MundoVentas> => mundoVentas(e, backend, { ruc: RUC_FIXTURE });

const PROV = { tipo: "6", numero: EMISORES["5070"]! };
const OTRO = { tipo: "6", numero: EMISORES["2056"]! };

function contexto(m: MundoVentas, proveedores = [PROV], periodo = PERIODO) {
  return dbWorker.withTenant({ tenantId: m.T }, (tx) => contextoGastos(tx, m.c.id, periodo, proveedores));
}

const coincide = (ctx: Awaited<ReturnType<typeof contexto>>, glosa: string) =>
  ctx.diccionario.coincidenciasPorItem([glosa]).map((c) => c.palabra);

describe("D-5: el lector único arma el contexto del estudio", () => {
  it("estudio sin ajustes: umbral 3, sin CIIU ni categorías ni historial, y el diccionario global de la semilla", async () => {
    const m = await mundo();
    const ctx = await contexto(m);

    expect(ctx.umbral).toBe(3);
    expect(ctx.ciiuCliente).toBeNull();
    expect(ctx.categoriasCliente).toEqual({ permitidas: [], quitadas: [] });
    expect(ctx.ciiuProveedores).toEqual([{ proveedor: PROV, ciiu: null }]);
    expect(ctx.historial).toEqual([{ proveedor: PROV, aceptadas6: 0, excluidas6: 0, excluidas12: 0 }]);
    expect(ctx.diccionario.coincidenciasPorItem(["ZAPATILLA URBANA T42"])).toEqual([
      { item: 0, palabra: "zapatilla", categoria: "calzado-ropa" },
    ]);
    expect(coincide(ctx, "zapatilla de seguridad"), "excepción de la semilla").toEqual([]);
    expect(coincide(ctx, "polo a tierra"), "excepción de la semilla").toEqual([]);
    expect(coincide(ctx, "polo azul")).toEqual(["polo"]);
  });

  it("estudio ajustado: umbral, palabras propias activas, globales desactivadas, categorías del cliente y CIIU de la caché", async () => {
    const m = await mundo();
    await fijarUmbral(admin, m, 7);
    await sembrarPalabra(admin, m, "audifono", { categoria: "entretenimiento" });
    await sembrarPalabra(admin, m, "tableta", { categoria: "entretenimiento", activa: false });
    await sembrarPalabra(admin, m, "lapicero", { categoria: "utiles-escolares", excepciones: ["tinta"] });
    await desactivarGlobal(admin, m, "polo");
    await fijarCategorias(admin, m, { permitidas: ["calzado-ropa"], quitadas: ["juguetes"] });
    await sembrarCiiu(admin, m.T, RUC_FIXTURE, "4752");
    await sembrarCiiu(admin, m.T, PROV.numero, "4771");
    await sembrarCiiu(admin, m.T, OTRO.numero, null);

    const ctx = await contexto(m, [PROV, OTRO]);

    expect(ctx.umbral).toBe(7);
    expect(ctx.ciiuCliente).toBe("4752");
    expect(ctx.categoriasCliente).toEqual({ permitidas: ["calzado-ropa"], quitadas: ["juguetes"] });
    expect(ctx.ciiuProveedores).toEqual([
      { proveedor: PROV, ciiu: "4771" },
      { proveedor: OTRO, ciiu: null },
    ]);
    expect(coincide(ctx, "AUDÍFONOS BLUETOOTH"), "propia activa").toEqual(["audifono"]);
    expect(coincide(ctx, "tableta 10 pulgadas"), "propia inactiva").toEqual([]);
    expect(coincide(ctx, "lapicero tinta azul"), "excepción propia").toEqual([]);
    expect(coincide(ctx, "lapicero azul")).toEqual(["lapicero"]);
    expect(coincide(ctx, "polo azul"), "global desactivada por el estudio").toEqual([]);
    expect(coincide(ctx, "blusa azul"), "las demás globales siguen").toEqual(["blusa"]);
  });

  it("el contexto de un estudio no ve nada de otro (diccionario, umbral, categorías ni CIIU)", async () => {
    const a = await mundo();
    await fijarUmbral(admin, a, 9);
    await sembrarPalabra(admin, a, "audifono");
    await desactivarGlobal(admin, a, "polo");
    await fijarCategorias(admin, a, { permitidas: ["calzado-ropa"] });
    await sembrarCiiu(admin, a.T, RUC_FIXTURE, "4752");
    await sembrarCiiu(admin, a.T, PROV.numero, "4771");

    const b = await mundo();
    const ctx = await contexto(b);

    expect(ctx.umbral).toBe(3);
    expect(ctx.ciiuCliente).toBeNull();
    expect(ctx.categoriasCliente).toEqual({ permitidas: [], quitadas: [] });
    expect(ctx.ciiuProveedores).toEqual([{ proveedor: PROV, ciiu: null }]);
    expect(coincide(ctx, "AUDIFONOS")).toEqual([]);
    expect(coincide(ctx, "polo azul")).toEqual(["polo"]);
  });

  it("sin proveedores pedidos no hay entradas de CIIU ni de historial", async () => {
    const m = await mundo();
    const ctx = await contexto(m, []);
    expect(ctx.ciiuProveedores).toEqual([]);
    expect(ctx.historial).toEqual([]);
  });

  it("historial por proveedor en los bordes de U-8: M−6/M−7, M−12/M−13, `abierto` no cuenta, excluida y restaurada, descartada", async () => {
    const m = await mundo();
    const compra = (periodo: string, numero: string) =>
      sembrarCompra(
        admin,
        m,
        filaCompra(numero, { rucContraparte: PROV.numero, fechaEmision: `${periodo.slice(0, 4)}-${periodo.slice(4)}-05` }),
        { periodo },
      );
    // Aceptadas en M−6 a M−1 con el periodo revisado: tres en 202604 y una excluida y luego restaurada en 202607.
    for (const n of ["1", "2", "3"]) await compra("202604", n);
    const restaurada = await compra("202607", "4");
    await nuevaVersion(admin, m, restaurada, { excluida: true, motivo: "x", accion: "excluir" });
    await nuevaVersion(admin, m, restaurada, { excluida: false, motivo: null, accion: "restaurar" });
    const descartada = await compra("202604", "5");
    await descartarCompra(admin, descartada);
    for (const p of ["202603", "202604", "202607"]) await fijarEstadoPeriodo(admin, m, "revisado", p);
    // No cuentan como aceptadas: M−7 (revisado), periodo abierto (202605) y el propio M.
    await compra("202603", "6");
    await compra("202605", "7");
    await compra(PERIODO, "8");
    // Excluidas: M−1.. M−6 (202606, periodo abierto: cuenta igual), M−12 (202510) sí y M−13 (202509) no.
    for (const periodo of ["202606", "202510", "202509"]) {
      const id = await compra(periodo, `9${periodo.slice(4)}`);
      await nuevaVersion(admin, m, id, { excluida: true, motivo: "gasto personal", accion: "excluir" });
    }

    const ctx = await contexto(m);
    expect(ctx.historial).toEqual([{ proveedor: PROV, aceptadas6: 4, excluidas6: 1, excluidas12: 2 }]);
  });

  it("solo lee: como mucho 4 consultas de negocio y ninguna escritura", async () => {
    const m = await mundo();
    await sembrarPalabra(admin, m, "audifono");
    const espia = espiarSentencias((dbWorker as unknown as { pool: unknown }).pool);
    try {
      await contexto(m, [PROV, OTRO]);
    } finally {
      espia.restaurar();
    }
    const textos = espia.sentencias.map((s) => s.texto);
    expect(textos.filter((t) => /\b(insert\s+into|update|delete\s+from)\b/i.test(t) && !/set_config/i.test(t))).toEqual([]);
    const negocio = textos.filter((t) => !/^\s*(begin|commit|rollback|set|reset|discard)\b/i.test(t) && !/set_config/i.test(t));
    expect(negocio.length, negocio.join("\n---\n")).toBeLessThanOrEqual(4);
  });

  it("alimenta el puntaje del dominio: el caso de CA-1 da 8 con el contexto leído (y 6 con calzado-ropa permitida)", async () => {
    const m = await mundo();
    await sembrarCiiu(admin, m.T, RUC_FIXTURE, "4752");
    await sembrarCiiu(admin, m.T, PROV.numero, "4771");
    const entrada = { glosas: ["ZAPATILLA URBANA T42"], fechaEmision: "2026-10-14", proveedor: PROV, esNuevo: false };

    expect(puntuarGastoPersonal(entrada, await contexto(m)).puntaje).toBe(8);
    await fijarCategorias(admin, m, { permitidas: ["calzado-ropa"] });
    expect(puntuarGastoPersonal(entrada, await contexto(m)).puntaje).toBe(6);
    await fijarUmbral(admin, m, 9);
    expect((await contexto(m)).umbral).toBe(9);
  });
});

describe("CA-13 · R-8: la descarga evalúa con el contexto del estudio cuando el XML del comprobante ya está guardado", () => {
  /** Descarga de los 5 fixtures con F001-5070 ya con su XML `subido` y el proveedor conocido; el proveedor de XML no encuentra otros. */
  async function descargarConXml(m: MundoVentas): Promise<void> {
    await sembrarCompra(
      admin,
      m,
      filaCompra("77", { rucContraparte: EMISORES["5070"]!, fechaEmision: "2026-09-10" }),
      { periodo: "202609" },
    );
    await sembrarXmlSubido(admin, m, "5070");
    await sembrarCiiu(admin, m.T, RUC_FIXTURE, "4752");
    await sembrarCiiu(admin, m.T, EMISORES["5070"]!, "4771");
    const p = puertosXml();
    p.xml.mock.fallar("no_encontrado");
    const w = await arrancarConCiiu(prefijo, p, new ConsultaRucCiiu());
    try {
      const id = await encolarDescarga(backend, redis, prefijo, m, { libro: "compras" });
      expect((await esperarTerminal(e, id, 30_000)).estado).toBe("completado");
      await esperarLotesXml(admin, m.c.id, 1, esperarHasta, 25_000);
    } finally {
      await w.detener({ esperaMs: 2000 });
    }
  }

  const porNumero = async (m: MundoVentas) => new Map((await comprasDe(admin, m.c.id)).map((c) => [c.numero, c]));

  it("el diccionario y las categorías del estudio ya rigen en la evaluación 1 de la descarga; las compras sin XML no se marcan", async () => {
    const m = await mundo();
    await desactivarGlobal(admin, m, "zapatilla");
    await sembrarPalabra(admin, m, "deportivas", { categoria: "entretenimiento" });
    await descargarConXml(m);

    const compras = await porNumero(m);
    const rgp = await rgpDe(admin, compras.get("5070")!.id, 1);
    expect(rgp, "R-GP en la evaluación 1 de F001-5070").not.toBeNull();
    expect(rgp!.sugerencia).toMatchObject({ palabra: "deportivas", categoria: "entretenimiento", puntaje: 8 });
    for (const [numero, c] of compras) {
      if (numero !== "5070") expect(await rgpDe(admin, c.id, 1), `R-GP en ${numero}`).toBeNull();
    }
    expect((await evaluacionesDe(admin, compras.get("5070")!.id)).map((x) => x.n)).toEqual([1]);
  });

  it("con el umbral del estudio en 9 la descarga no marca el puntaje 8", async () => {
    const m = await mundo();
    await fijarUmbral(admin, m, 9);
    await descargarConXml(m);

    expect(await rgpDe(admin, (await porNumero(m)).get("5070")!.id, 1)).toBeNull();
  });

  it("con el ajuste de categorías del cliente (calzado-ropa permitida) el puntaje de la descarga es 6", async () => {
    const m = await mundo();
    await fijarCategorias(admin, m, { permitidas: ["calzado-ropa"] });
    await descargarConXml(m);

    const rgp = await rgpDe(admin, (await porNumero(m)).get("5070")!.id, 1);
    expect(rgp!.sugerencia).toMatchObject({ palabra: "zapatilla", puntaje: 6 });
  });
});

describe("CA-13: 012b arma el contexto del estudio y R-GP nunca bloquea la generación", () => {
  it("con umbral 1 y una compra con XML de «zapatillas», el archivo se genera; el contexto se lee en la misma transacción y no se escribe nada de 027", async () => {
    const m = await mundo();
    await sembrarComprasBase(admin, m);
    await sembrarCompra(
      admin,
      m,
      filaCompra("5070", { rucContraparte: EMISORES["5070"]!, fechaEmision: "2026-10-14" }),
    );
    await sembrarXmlSubido(admin, m, "5070");
    await fijarUmbral(admin, m, 1);
    await sembrarPalabra(admin, m, "deportivas", { categoria: "entretenimiento" });
    await sembrarCiiu(admin, m.T, RUC_FIXTURE, "4752");
    await sembrarCiiu(admin, m.T, EMISORES["5070"]!, "4771");

    const previo = await previoDe(admin, m, "compras");
    expect(previo.resultado.apto, "el periodo sembrado debe ser apto").toBe(true);
    const parametros: ParametrosGenerar = {
      periodo: PERIODO,
      libro: "compras",
      estadoVisto: "abierto",
      huella: await huellaDe(admin, m, "compras"),
    };
    const almacen = new AlmacenEspia();
    const id = await encolarGenerar(admin, backend, redis, prefijo, m, parametros);

    const espia = espiarSentencias((dbWorker as unknown as { pool: unknown }).pool);
    let resultado: unknown;
    try {
      resultado = await generarArchivo({ db: dbWorker, storage: almacen })(ctxDe(m, id, parametros));
    } finally {
      espia.restaurar();
    }

    expect(resultado).toMatchObject({ nueva: true, version: 1 });
    expect(almacen.rutas()).toHaveLength(1);

    const textos = espia.sentencias.map((s) => s.texto);
    expect(textos.filter((t) => /\b(insert\s+into|update|delete\s+from)\s+"?(public"?\."?)?gnd_/i.test(t))).toEqual([]);
    const escritura = espia.sentencias.find((s) => /insert\s+into\s+"?archivo_generado/i.test(s.texto));
    expect(escritura, "la versión se inserta en una transacción").toBeDefined();
    const tx = transaccionDe(espia.sentencias, escritura!).map((s) => s.texto);
    expect(
      tx.some((t) => /\bgnd_/i.test(t)),
      "el contexto de gastos se lee en la misma transacción que escribe la versión",
    ).toBe(true);
  });
});

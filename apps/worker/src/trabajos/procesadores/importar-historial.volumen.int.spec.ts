import type { ContappDb } from "@contapp/db";
import {
  generarFilasComprasVolumen,
  type FilaPropuestaSire,
} from "@contapp/sunat";
import type { Redis } from "ioredis";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  arrancar007b,
  esperarTerminal,
} from "../../../test/procesadores-007b.js";
import { limpiarCompras } from "../../../test/compras.js";
import {
  SireRegistroControlado,
  candidatasDe,
  comoEsperada,
  crearDirFixtures,
  deducir,
  encolarImportacion,
  importacionDe,
  iniciarImportacion,
  limpiarAprendizaje,
  reglasDeCliente,
  type DirFixtures,
} from "../../../test/importar-historial.js";
import { limpiarReglas } from "../../../test/reglas.js";
import {
  Escenario,
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  fijarConfig,
  limpiarPrefijo,
  nuevoPrefijo,
  restaurarConfig,
} from "../../../test/trabajos.js";
import { mundoVentas } from "../../../test/ventas.js";

// Spec 025, T5 (rojo; integración con PostgreSQL y Redis reales y el mock de SireApiClient): volumen de CA-13. Importar los
// 12 periodos del máximo (U-5) con 5.000 compras cada uno (60.000 filas, archivos de más de 1 MiB en una carpeta temporal del mock)
// termina en menos de 60 s con el mock y deja exactamente lo que deduce el oráculo simple de la prueba (una transacción con
// miles de candidatas, plan 025, Riesgos: «Volumen»). La lista de 1.000 candidatas con p95 < 300 ms es de T6 (backend).
//
// CONTRATO que fija (T11): el procesador no tiene tope de filas por periodo menor a 5.000 ni acumula más memoria que las
// filas leídas, y su escritura única admite todas las candidatas (por lotes dentro de la misma transacción si hace falta).

vi.setConfig({ testTimeout: 240_000, hookTimeout: 60_000 });

const PERIODOS_12 = [
  "202610",
  "202609",
  "202608",
  "202607",
  "202606",
  "202605",
  "202604",
  "202603",
  "202602",
  "202601",
  "202512",
  "202511",
] as const;
const FILAS_POR_PERIODO = 5_000;
const LIMITE_MS = 60_000;

let admin: ContappDb;
let backend: ContappDb;
let redis: Redis;
let e: Escenario;
let fx: DirFixtures;
let prefijo = nuevoPrefijo();
const prefijos = [prefijo];
beforeEach(() => {
  prefijo = nuevoPrefijo();
  prefijos.push(prefijo);
});

beforeAll(async () => {
  admin = crearDbAdmin();
  backend = crearDbRol("contapp_backend");
  redis = conectarRedis();
  e = new Escenario(admin);
  fx = crearDirFixtures();
  await fijarConfig(admin, "sire", {
    global: 4,
    tenant: 2,
    espera: 0,
    reintentos: 1,
    base: 100,
  });
});

afterAll(async () => {
  await restaurarConfig(admin).catch(() => undefined);
  await limpiarAprendizaje(admin, e?.estudios ?? []).catch(() => undefined);
  await limpiarReglas(admin, e?.estudios ?? []).catch(() => undefined);
  await limpiarCompras(admin, e?.estudios ?? []).catch(() => undefined);
  await e?.limpiar();
  for (const x of prefijos)
    await limpiarPrefijo(redis, x).catch(() => undefined);
  redis?.disconnect();
  fx?.limpiar();
  await Promise.all([backend?.close(), admin?.close()]);
});

describe("CA-13: 12 periodos × 5.000 compras", () => {
  it(`se importa en menos de ${LIMITE_MS / 1000} s, con una candidata por proveedor, tal como las deduce el oráculo`, async () => {
    const m = await mundoVentas(e, backend);
    const porPeriodo = new Map<string, FilaPropuestaSire[]>(
      PERIODOS_12.map((p) => [
        p,
        // T20 (H-025-2-1): el generador repite serie y números en cada periodo; una serie por periodo los hace comprobantes
        // distintos, como en un registro real (si no, contarían una sola vez).
        generarFilasComprasVolumen(FILAS_POR_PERIODO, p).map((f) => ({
          ...f,
          serie: `F${p.slice(3)}`,
        })),
      ]),
    );
    // Los archivos del registro pasan de 1 MiB cada uno: el tope del mock admite 5.000 compras (T2).
    expect(JSON.stringify(porPeriodo.get("202610")).length).toBeGreaterThan(
      1_048_576,
    );
    fx.registro(m.c.ruc, porPeriodo);
    const esperadas = deducir(porPeriodo, PERIODOS_12);
    const proveedores = new Set(
      [...porPeriodo.values()].flatMap((fs) => fs.map((f) => f.rucContraparte)),
    );
    expect(esperadas.length, "control: un candidato por proveedor").toBe(
      proveedores.size,
    );
    expect(esperadas.length).toBeGreaterThan(1);

    const api = new SireRegistroControlado(fx.dir);
    const p = await arrancar007b({
      prefijo,
      sireApi: api,
    } as Parameters<typeof arrancar007b>[0]);
    api.contarTx = () => p.dbEstado.abiertas;
    let ms: number;
    let importacionId: string;
    let fila: Awaited<ReturnType<typeof esperarTerminal>>;
    try {
      const t0 = performance.now();
      importacionId = await iniciarImportacion(backend, m, PERIODOS_12);
      const trabajoId = await encolarImportacion(
        backend,
        redis,
        prefijo,
        m,
        importacionId,
      );
      fila = await esperarTerminal(e, trabajoId, 120_000);
      ms = performance.now() - t0;
    } finally {
      await p.detener({ esperaMs: 2000 });
    }

    expect([fila.estado, fila.motivo, fila.intentos]).toEqual([
      "completado",
      null,
      0,
    ]);
    expect(ms, `tardó ${Math.round(ms)} ms`).toBeLessThan(LIMITE_MS);
    expect(api.llamadas.map((l) => l.solicitud.periodo)).toEqual([
      ...PERIODOS_12,
    ]);

    const sinCriterio = esperadas.filter(
      (c) => c.destino_propuesto === null,
    ).length;
    expect((fila as { resultado?: unknown }).resultado).toEqual({
      periodosLeidos: 12,
      periodosSinDatos: 0,
      candidatas: esperadas.length,
      sinCriterio,
    });
    expect(await importacionDe(admin, importacionId)).toMatchObject({
      estado: "completada",
      periodos_leidos: 12,
      candidatas: esperadas.length,
      sin_criterio: sinCriterio,
    });
    const cands = await candidatasDe(admin, { importacionId });
    expect(cands.map(comoEsperada)).toEqual(esperadas);
    // Las 60.000 filas quedaron contadas: ninguna se perdió por el camino y ninguna se aplicó.
    expect(cands.reduce((s, c) => s + c.n_total, 0)).toBe(
      PERIODOS_12.length * FILAS_POR_PERIODO,
    );
    expect(cands.every((c) => c.estado === "pendiente")).toBe(true);
    expect(await reglasDeCliente(admin, m.c.id)).toEqual([]);
  });
});

import type { ContappDb } from "@contapp/db";
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
import { esperarTerminal } from "../../../test/procesadores-007b.js";
import {
  RUC_FIXTURE,
  comprasDe,
  encolarDescarga,
  limpiarCompras,
  mundoVentas,
  type MundoVentas,
} from "../../../test/compras.js";
import { fijarInterruptor, limpiarReglas, type CodigoMotor } from "../../../test/reglas.js";
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
  type ProcesoWorker,
} from "../../../test/trabajos.js";
import {
  NUMEROS_FIXTURE,
  RESULTADO_CERO,
  arrancarXml,
  documentosDe,
  esperarLotesXml,
  evaluacionesDe,
  hallazgosEvaluadosDe,
  limpiarXml,
  puertosXml,
  type PuertosXml,
} from "../../../test/xml.js";

// Spec 021, T4 (rojo; integración con PostgreSQL y Redis reales, BullMQ real, `MockXmlProvider` y un storage en memoria): los
// interruptores de reglas del estudio (RF-089; CA-8) también gobiernan la re-evaluación con el XML que llega.
//
// CONTRATO que fija (T10): `xml.obtener` lee los interruptores del estudio en la misma transacción en que re-evalúa y pasa a
// `crearEvaluarCompras` las reglas apagadas (`reglasApagadas`): la evaluación nueva (`n + 1`) no guarda hallazgos del código
// apagado y sí los de los demás. Lo ya guardado (la evaluación 1 de la descarga) no se borra ni se toca.

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

let admin: ContappDb;
let backend: ContappDb;
let redis: Redis;
let e: Escenario;
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
  await fijarConfig(admin, "sire", {
    global: 4,
    tenant: 2,
    espera: 0,
    reintentos: 1,
    base: 100,
  });
  await fijarConfig(admin, "xml", {
    global: 4,
    tenant: 2,
    espera: 0,
    reintentos: 2,
    base: 100,
  });
});

afterAll(async () => {
  await restaurarConfig(admin).catch(() => undefined);
  await limpiarReglas(admin, e?.estudios ?? []).catch(() => undefined);
  await limpiarXml(admin, e?.estudios ?? []).catch(() => undefined);
  await limpiarCompras(admin, e?.estudios ?? []).catch(() => undefined);
  await e?.limpiar();
  for (const x of prefijos)
    await limpiarPrefijo(redis, x).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([backend?.close(), admin?.close()]);
});

async function conWorker<T>(
  p: PuertosXml,
  fn: (w: ProcesoWorker) => Promise<T>,
): Promise<T> {
  const w = await arrancarXml(prefijo, p, { simuladoEnReglas: true });
  try {
    return await fn(w);
  } finally {
    await w.detener({ esperaMs: 2000 });
  }
}

async function descargar(m: MundoVentas, timeoutMs = 30_000) {
  const id = await encolarDescarga(backend, redis, prefijo, m, {
    libro: "compras",
  });
  const f = await esperarTerminal(e, id, timeoutMs);
  return { estado: f.estado, motivo: f.motivo };
}

const lotes = (m: MundoVentas, minimo: number, timeoutMs = 25_000) =>
  esperarLotesXml(admin, m.c.id, minimo, esperarHasta, timeoutMs);

const CASOS: Array<{
  apagado: CodigoMotor;
  numero: string;
  otra: { regla: CodigoMotor; numero: string };
}> = [
  // La mixta 21.48 / 1.61 trae R-MIX y San Juan trae R-ISC (fixtures de 014/016).
  { apagado: "R-MIX", numero: "2056", otra: { regla: "R-ISC", numero: "1040" } },
  { apagado: "R-ISC", numero: "1040", otra: { regla: "R-MIX", numero: "2056" } },
];

describe("CA-8: los interruptores del estudio gobiernan la re-evaluación con XML", () => {
  it.each(CASOS)(
    "$apagado apagado cuando llega el XML: la evaluación 2 no guarda $apagado y sí $otra.regla; la evaluación 1 no cambia",
    async ({ apagado, numero, otra }) => {
      const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
      const p = puertosXml();
      // El XML llega después de la descarga (queda detenido en el proveedor): entre una cosa y otra se apaga la regla.
      p.xml.pausar();
      const r = await conWorker(p, async () => {
        expect((await descargar(m)).estado).toBe("completado");
        await esperarHasta(
          () => p.xml.llamadas.length > 0,
          "el proveedor recibe el pedido",
        );
        await fijarInterruptor(admin, m, apagado, false);
        p.xml.abrir();
        return lotes(m, 1);
      });
      expect(r[0]).toMatchObject({
        estado: "completado",
        resultado: { ...RESULTADO_CERO, guardados: 5 },
      });

      const compras = new Map(
        (await comprasDe(admin, m.c.id)).map((c) => [c.numero, c]),
      );
      const docs = await documentosDe(admin, m.c.id);
      expect(docs).toHaveLength(5);

      // Todas se re-evaluaron (n = 2), sin versión nueva.
      for (const n of NUMEROS_FIXTURE) {
        const ev = await evaluacionesDe(admin, compras.get(n)!.id);
        expect(ev.map((x) => [x.version_n, x.n]), n).toEqual([
          [1, 1],
          [1, 2],
        ]);
        expect(compras.get(n)!.version_vigente, n).toBe(1);
      }

      // La compra del código apagado: lo guardado en la descarga sigue (evaluación 1); la evaluación 2 ya no lo trae.
      const hs = await hallazgosEvaluadosDe(admin, compras.get(numero)!.id);
      expect(
        hs.filter((h) => h.regla === apagado && h.evaluacion_n === 1),
        `${apagado} en la evaluación 1`,
      ).not.toHaveLength(0);
      expect(
        hs.filter((h) => h.regla === apagado && h.evaluacion_n === 2),
        `${apagado} en la evaluación 2`,
      ).toHaveLength(0);

      // Control: el otro código sigue evaluándose con el XML.
      const hsOtra = await hallazgosEvaluadosDe(
        admin,
        compras.get(otra.numero)!.id,
      );
      expect(
        hsOtra.filter((h) => h.regla === otra.regla && h.evaluacion_n === 2),
        `${otra.regla} en la evaluación 2`,
      ).not.toHaveLength(0);
    },
  );
});

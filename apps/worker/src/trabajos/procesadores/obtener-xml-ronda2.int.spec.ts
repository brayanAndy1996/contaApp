// Spec 016 · T22 · H-016-11 (worker, rojo): cuando LLEGA un XML (xml.obtener), se re-evalúan TODAS las compras de ese comprobante
// (mismo cliente e identidad, en cualquier periodo no descartado), no solo la del lote (D-4, D-5: el XML vigente es del
// comprobante; una compra del mismo comprobante en otro periodo quedaría con hallazgos de un XML que ya no es el vigente).
// Integración con PostgreSQL real, rol contapp_worker, sin Redis ni BullMQ: se llama al procesador directamente.
// Hoy el procesador solo re-evalúa `c.id` (la compra del lote). Las pruebas de "se mantiene" (bandera apagada, descartadas y
// otros clientes) pasan hoy: son la red de seguridad de la corrección.
import { createDb, type ContappDb } from "@contapp/db";
import type { RespuestaXml, XmlProvider } from "@contapp/sunat";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  RUC_FIXTURE,
  descartarCompra,
  filaCompra,
  limpiarCompras,
  sembrarCompra,
} from "../../../test/compras.js";
import { Escenario, crearDbAdmin } from "../../../test/trabajos.js";
import {
  AlmacenEspia,
  EMISORES,
  evaluacionesDe,
  fixtureXml,
  hallazgosEvaluadosDe,
  limpiarXml,
} from "../../../test/xml.js";
import { obtenerXml } from "./obtener-xml.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const P1 = "202610";
const P2 = "202609";
const P3 = "202608";

let admin: ContappDb;
let worker: ContappDb;
let e: Escenario;

beforeAll(() => {
  admin = crearDbAdmin();
  worker = createDb({ rolApp: "contapp_worker", poolMax: 4 });
  e = new Escenario(admin);
});
afterAll(async () => {
  await limpiarXml(admin, e?.estudios ?? []).catch(() => undefined);
  await limpiarCompras(admin, e?.estudios ?? []).catch(() => undefined);
  await e?.limpiar();
  await Promise.all([worker?.close(), admin?.close()]);
});

/** Proveedor de XML que entrega el fixture 2056 con el origen pedido (el mock solo da `simulado`). */
function proveedor(origen: "simulado" | "real"): XmlProvider {
  return {
    obtener: async (): Promise<RespuestaXml> => ({
      xml: fixtureXml("2056"),
      origen,
      fuente: "fixture",
    }),
  } as XmlProvider;
}

/** Compra F001-2056 mixta (21.48 + 1.61 = 23.09, la de CA-6) del proveedor de los fixtures. */
const mixta = () =>
  filaCompra("2056", {
    rucContraparte: EMISORES["2056"]!,
    biDg: "21.48",
    igvDg: "1.61",
    total: "23.09",
  });

async function escenario() {
  const T = await e.estudio();
  const u = await e.usuario(T, "contador");
  const c = await e.cliente(T, RUC_FIXTURE);
  await e.asignar(T, c.id, u);
  const otro = await e.cliente(T);
  await e.asignar(T, otro.id, u);
  const m = { T, u, c };
  const enP1 = await sembrarCompra(admin, m, mixta(), { periodo: P1 });
  const enP2 = await sembrarCompra(admin, m, mixta(), { periodo: P2 });
  const descartada = await sembrarCompra(admin, m, mixta(), { periodo: P3, origen: "agregada" });
  await descartarCompra(admin, descartada);
  const deOtroCliente = await sembrarCompra(admin, { ...m, c: otro }, mixta(), { periodo: P1, clienteId: otro.id });
  return { m, enP1, enP2, descartada, deOtroCliente };
}

/** Ejecuta el procesador `xml.obtener` para la compra del lote (como lo hace el ejecutor de 008, sin cola). */
async function llegaElXml(
  s: Awaited<ReturnType<typeof escenario>>,
  origen: "simulado" | "real",
  xmlSimuladoEnReglas: boolean,
) {
  const almacen = new AlmacenEspia();
  const procesador = obtenerXml({
    db: worker,
    xmlProvider: proveedor(origen),
    storage: almacen,
    xmlSimuladoEnReglas,
  });
  const resultado = await procesador({
    trabajo: {
      id: "j-ronda2",
      tenantId: s.m.T,
      clienteId: s.m.c.id,
      ruc: RUC_FIXTURE,
      tipo: "xml.obtener",
      parametros: { periodo: P1, compraIds: [s.enP1] },
      intentos: 0,
      creadoPor: s.m.u,
    },
    conToken: vi.fn(),
  } as never);
  return { resultado, almacen };
}

const xmlIdDe = async (clienteId: string): Promise<string> =>
  (
    await admin.pool.query(
      "select id from documento_xml where cliente_id = $1 and serie = 'F001' and numero = '2056' order by n desc limit 1",
      [clienteId],
    )
  ).rows[0].id as string;

describe("H-016-11 · el XML que llega re-evalúa todas las compras de su comprobante (worker)", () => {
  it.each([
    ["real con la bandera apagada (producción)", "real", false],
    ["simulado con XML_SIMULADO_EN_REGLAS=1", "simulado", true],
  ] as const)(
    "XML %s: la compra del otro periodo queda re-evaluada con ese XML (evaluación nueva y R-MIX exacto 8.97)",
    async (_nombre, origen, bandera) => {
      const s = await escenario();
      const { resultado } = await llegaElXml(s, origen, bandera);
      expect(resultado).toMatchObject({ guardados: 1 });
      const xmlId = await xmlIdDe(s.m.c.id);

      for (const [nombre, id] of [
        ["la del lote (P1)", s.enP1],
        ["la del mismo comprobante en otro periodo (P2)", s.enP2],
      ] as const) {
        const evaluaciones = await evaluacionesDe(admin, id);
        expect(evaluaciones.at(-1)?.documento_xml_id, `${nombre}: la última evaluación usa el XML vigente`).toBe(xmlId);
        const mix = (await hallazgosEvaluadosDe(admin, id)).find(
          (h) => h.regla === "R-MIX" && h.evaluacion_n === evaluaciones.at(-1)!.n,
        );
        expect(mix, `${nombre}: R-MIX en la evaluación con XML`).toBeDefined();
        expect(mix!.requiere_confirmacion, nombre).toBe(false);
        expect(mix!.sugerencia, nombre).toMatchObject({ exacto: "8.97" });
      }
    },
  );

  it("no re-evalúa la descartada del mismo comprobante ni la compra de otro cliente del estudio", async () => {
    const s = await escenario();
    await llegaElXml(s, "real", false);
    expect(await evaluacionesDe(admin, s.descartada), "descartada: D-7, no cambia").toEqual([]);
    expect(await evaluacionesDe(admin, s.deOtroCliente), "otro cliente: su XML es otro").toEqual([]);
  });

  it("se mantiene (P-4): un XML simulado con la bandera apagada solo se guarda; ninguna compra se re-evalúa", async () => {
    const s = await escenario();
    const { resultado } = await llegaElXml(s, "simulado", false);
    expect(resultado).toMatchObject({ guardados: 1 });
    for (const id of [s.enP1, s.enP2]) expect(await evaluacionesDe(admin, id)).toEqual([]);
  });
});

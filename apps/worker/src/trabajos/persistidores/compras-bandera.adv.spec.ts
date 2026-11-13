// Spec 016 · T21 · ronda adversarial 2 (caja blanca, worker): la descarga evalúa cada compra nueva con el XML vigente de su
// comprobante (`evaluarYGuardar` lo lee y la evaluación guarda su id), así que debe hacerlo con la MISMA bandera P-4 que el resto
// del worker y del backend (D-7, CA-16; 014 D-4: un solo entorno). Con `XML_SIMULADO_EN_REGLAS=1`, una compra que llega en la
// descarga y cuyo comprobante ya tiene un XML simulado debe salir con el R-MIX exacto, como si la evaluara `xml.obtener` o el
// backend. Una prueba en rojo es un hallazgo H-016-n. W1 -> H-016-13.
import { readFileSync } from "node:fs";
import type { CompraConXml, EvaluarCompra } from "@contapp/db";
import { crearEvaluarCompras as evaluarDominio, leerUbl } from "@contapp/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capturado: { evaluar?: EvaluarCompra } = {};
vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  leerProveedoresConocidos: vi.fn(async () => [{ tipo: "6", numero: "20700000045" }]),
  // 021: el persistidor lee las reglas vigentes y los interruptores del estudio; aquí no hay reglas ni interruptores.
  reglasHistorialVigentes: vi.fn(async () => []),
  leerReglasMotor: vi.fn(async () => ({ filas: [], aportarCatalogo: true })),
  insertarCompras: vi.fn(async (_tx: unknown, _c: unknown, _n: unknown, f: { evaluar: EvaluarCompra }) => {
    capturado.evaluar = f.evaluar;
    return [];
  }),
}));

const { persistidorCompras } = await import("./compras.js");

const MONTOS = {
  biDg: "21.48", igvDg: "1.61", biDgng: "0.00", igvDgng: "0.00", biDng: "0.00", igvDng: "0.00",
  noGravado: "0.00", isc: "0.00", icbper: "0.00", otrosTributos: "0.00", total: "23.09",
};

function filaConSimulado(): CompraConXml {
  const texto = readFileSync(new URL("../../../../../fixtures/xml/20700000045-01-F001-2056.xml", import.meta.url), "utf8");
  return {
    id: "00000000-0000-4000-8000-000000000001",
    clienteId: "00000000-0000-4000-8000-000000000002",
    periodo: "202610",
    propuestaId: "00000000-0000-4000-8000-000000000003",
    origen: "sire",
    clave: "01|F001|2056|6|20700000045",
    tipoDoc: "01",
    serie: "F001",
    numero: "2056",
    docTipo: "6",
    docNumero: "20700000045",
    razonSocial: null,
    fecha: "2026-10-05",
    moneda: "PEN",
    tipoCambio: null,
    version: 1,
    excluida: false,
    motivo: null,
    clasificada: false,
    montos: MONTOS,
    xml: { origen: "simulado", detalle: leerUbl(new TextEncoder().encode(texto)) },
  } as unknown as CompraConXml;
}

let bandera: string | undefined;
beforeEach(() => {
  bandera = process.env.XML_SIMULADO_EN_REGLAS;
  process.env.XML_SIMULADO_EN_REGLAS = "1";
});
afterEach(() => {
  if (bandera === undefined) delete process.env.XML_SIMULADO_EN_REGLAS;
  else process.env.XML_SIMULADO_EN_REGLAS = bandera;
});

describe("T21 · la descarga (persistidor de compras) evalúa con la bandera P-4 del worker", () => {
  it("W1 · con XML_SIMULADO_EN_REGLAS=1, la compra nueva con un XML simulado guardado sale con R-MIX exacto (como xml.obtener y el backend)", async () => {
    await persistidorCompras.insertar(
      {} as never,
      { clienteId: "00000000-0000-4000-8000-000000000002", periodo: "202610" },
      "00000000-0000-4000-8000-000000000003",
      [{ datos: {} } as never],
    );
    expect(capturado.evaluar, "insertarCompras recibió la función de evaluar").toBeTypeOf("function");
    const fila = filaConSimulado();
    const delPersistidor = await capturado.evaluar!(fila);
    const { xml, ...resto } = fila;
    const conBandera = evaluarDominio([{ tipo: "6", numero: "20700000045" }], { xmlSimuladoEnReglas: true })({
      ...resto,
      xml: { origen: "simulado", detalle: xml!.detalle as never },
    });
    expect(conBandera.find((h) => h.regla === "R-MIX")).toMatchObject({ requiereConfirmacion: false });
    expect(
      delPersistidor,
      "la evaluación de la descarga ignora la bandera: guarda documento_xml_id del simulado pero hallazgos sin él",
    ).toEqual(conBandera);
  });
});

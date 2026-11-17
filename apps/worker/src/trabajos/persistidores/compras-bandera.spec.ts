// Spec 016 · T22 · H-016-13 (rojo): la descarga de compras evalúa las compras nuevas con la bandera P-4 (`XML_SIMULADO_EN_REGLAS`)
// y con el XML guardado del comprobante, igual que `xml.obtener` y el backend (D-7, CA-16; 014 D-4: un solo entorno).
// `insertarCompras` (packages/db) lee el XML vigente de cada compra nueva y se lo pasa a `evaluar`; lo que decide el persistidor es
// con qué bandera lo evalúa. Hoy `crearEvaluarCompras(conocidos)` no recibe la bandera: el XML simulado nunca entra en las reglas
// aunque la bandera esté en 1, pero la evaluación guarda igual el id de ese XML.
// La bandera se lee en cada descarga (el módulo se importa antes de fijar el entorno, como hace el backend con `process.env`).
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

const CONOCIDOS = [{ tipo: "6", numero: "20700000045" }];
const MONTOS = {
  biDg: "21.48", igvDg: "1.61", biDgng: "0.00", igvDgng: "0.00", biDng: "0.00", igvDng: "0.00",
  noGravado: "0.00", isc: "0.00", icbper: "0.00", otrosTributos: "0.00", total: "23.09",
};
const CTX = { clienteId: "00000000-0000-4000-8000-000000000002", periodo: "202610" };
const PROPUESTA = "00000000-0000-4000-8000-000000000003";

const detalleMixta = () =>
  leerUbl(
    new TextEncoder().encode(
      readFileSync(new URL("../../../../../fixtures/xml/20700000045-01-F001-2056.xml", import.meta.url), "utf8"),
    ),
  );

/** La fila que `insertarCompras` entrega a `evaluar`: la mixta F001-2056 con el XML guardado del comprobante (o sin él). */
function fila(xml: { origen: "simulado" | "real" | "subido" } | null): CompraConXml {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    clienteId: CTX.clienteId,
    periodo: CTX.periodo,
    propuestaId: PROPUESTA,
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
    xml: xml === null ? null : { origen: xml.origen, detalle: detalleMixta() },
  } as unknown as CompraConXml;
}

/** Lo que el dominio da para esa fila con la bandera indicada: la referencia de «igual que xml.obtener y el backend». */
function esperado(f: CompraConXml, xmlSimuladoEnReglas: boolean) {
  const { xml, ...resto } = f;
  return evaluarDominio(CONOCIDOS, { xmlSimuladoEnReglas })(
    xml === null ? (resto as never) : ({ ...resto, xml: { origen: xml.origen, detalle: xml.detalle as never } } as never),
  );
}

/** Corre una descarga y devuelve la función `evaluar` que el persistidor le dio a `insertarCompras`. */
async function evaluarDeLaDescarga(): Promise<EvaluarCompra> {
  capturado.evaluar = undefined;
  await persistidorCompras.insertar({} as never, CTX, PROPUESTA, [{ datos: {} } as never]);
  expect(capturado.evaluar, "insertarCompras recibió la función de evaluar").toBeTypeOf("function");
  return capturado.evaluar!;
}

let original: string | undefined;
beforeEach(() => {
  original = process.env.XML_SIMULADO_EN_REGLAS;
});
afterEach(() => {
  if (original === undefined) delete process.env.XML_SIMULADO_EN_REGLAS;
  else process.env.XML_SIMULADO_EN_REGLAS = original;
});

describe("H-016-13 · la descarga evalúa con la bandera P-4 y el XML guardado del comprobante", () => {
  it("con XML_SIMULADO_EN_REGLAS=1 y un XML simulado guardado: R-MIX exacto sin confirmación, como xml.obtener y el backend", async () => {
    process.env.XML_SIMULADO_EN_REGLAS = "1";
    const f = fila({ origen: "simulado" });
    const hallazgos = await (await evaluarDeLaDescarga())(f);
    expect(esperado(f, true).find((h) => h.regla === "R-MIX")).toMatchObject({
      requiereConfirmacion: false,
      sugerencia: { exacto: "8.97" },
    });
    expect(hallazgos).toEqual(esperado(f, true));
  });

  it("con la bandera en 1, un XML real y uno subido entran en las reglas igual que el simulado", async () => {
    process.env.XML_SIMULADO_EN_REGLAS = "1";
    const evaluar = await evaluarDeLaDescarga();
    for (const origen of ["real", "subido"] as const) {
      const f = fila({ origen });
      expect(await evaluar(f), origen).toEqual(esperado(f, true));
    }
  });

  it("la bandera se lee en cada descarga: tras apagarla, el mismo XML simulado ya no entra en las reglas", async () => {
    process.env.XML_SIMULADO_EN_REGLAS = "1";
    const f = fila({ origen: "simulado" });
    expect(await (await evaluarDeLaDescarga())(f)).toEqual(esperado(f, true));
    process.env.XML_SIMULADO_EN_REGLAS = "0";
    expect(await (await evaluarDeLaDescarga())(f)).toEqual(esperado(f, false));
    expect(esperado(f, false), "con la bandera apagada el R-MIX no trae el exacto del simulado").not.toEqual(
      esperado(f, true),
    );
  });

  it("se mantiene (CA-16): sin la variable, un XML simulado se trata como si no hubiera XML", async () => {
    delete process.env.XML_SIMULADO_EN_REGLAS;
    const f = fila({ origen: "simulado" });
    expect(await (await evaluarDeLaDescarga())(f)).toEqual(esperado(f, false));
    expect(esperado(f, false)).toEqual(esperado(fila(null), false));
  });

  it("se mantiene: una compra nueva sin XML se evalúa igual con la bandera en 1 que en 0", async () => {
    process.env.XML_SIMULADO_EN_REGLAS = "1";
    const f = fila(null);
    expect(await (await evaluarDeLaDescarga())(f)).toEqual(esperado(f, true));
    expect(esperado(f, true)).toEqual(esperado(f, false));
  });
});

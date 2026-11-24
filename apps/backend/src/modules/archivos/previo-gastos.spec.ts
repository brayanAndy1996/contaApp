// Spec 027 (T23a) · `calcularPrevio` de compras sin BD: las ramas que 027 agregó a `previo.ts` (D-5, CA-13). R-GP puntúa con el XML vigente de
// cada compra y el contexto de gastos del estudio; solo avisa. Se prueba con `tx.query` simulado (el SQL del XML vigente) y la lectura de
// filas, reglas y contexto de `@contapp/db` simulada: lo que `prepararArchivo` recibe (filas con `xml`, `reglas.gastos`, `diccionario`) es el
// contrato observable. Los casos con BD real (XML subido, R-GP apagada) están en `previo.int.spec.ts` y `contexto.int.spec.ts`.
import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  leerClienteDto: vi.fn(),
  leerEstadoPeriodo: vi.fn(),
  leerFilasReemplazo: vi.fn(),
  leerProveedoresConocidos: vi.fn(),
  leerReglasMotor: vi.fn(),
  leerContextoGastos: vi.fn(),
  ultimaVersion: vi.fn(),
}));
vi.mock("@contapp/domain", async (original) => ({
  ...(await original<typeof import("@contapp/domain")>()),
  prepararArchivo: vi.fn(),
}));
vi.mock("../compras/apoyo.js", async (original) => ({
  ...(await original<typeof import("../compras/apoyo.js")>()),
  exigirCliente: vi.fn().mockResolvedValue(undefined),
}));

import {
  leerClienteDto,
  leerContextoGastos,
  leerEstadoPeriodo,
  leerFilasReemplazo,
  leerProveedoresConocidos,
  leerReglasMotor,
  ultimaVersion,
  type Alcance,
} from "@contapp/db";
import {
  compraLeidaAFila,
  DICCIONARIO_GLOSAS_BASE,
  Money,
  prepararArchivo,
  type ArchivoPreparado,
  type CompraLeidaPlana,
  type FilaReemplazo,
} from "@contapp/domain";
import { calcularPrevio } from "./previo.js";

const CLIENTE = "0190a000-0000-7000-8000-0000000000c1";
const alcance: Alcance = { tipo: "global" };
const entrada = { alcance, clienteId: CLIENTE, periodo: "202610", libro: "compras" as const, nodeEnv: "test" };

type Fila = { compra_id: string; origen: string; detalle: unknown };
const query = vi.fn<(sql: string, valores: unknown[]) => Promise<{ rows: Fila[] }>>();
const tx = { query } as never;

const preparado = {
  resultado: { apto: true, errores: [], formato: { id: "provisional-rce", version: "1", oficial: false } },
  resumen: { modificadas: 0, excluidas: 0, agregadas: 0, impactoIgv: { total: Money.cero("PEN") }, filasSinConvertir: [] },
  avisos: [],
  generable: true,
  motivo: null,
  canon: "canon-fijo",
} as unknown as ArchivoPreparado;

const compra = (n: number, extra: Partial<CompraLeidaPlana> = {}): CompraLeidaPlana & { clienteId: string } => ({
  id: `c${n}`,
  clienteId: CLIENTE,
  origen: "sire",
  tipoDoc: "01",
  serie: "F001",
  numero: String(n).padStart(8, "0"),
  docTipo: "6",
  docNumero: `2010000${String(n).padStart(4, "0")}`,
  razonSocial: `Proveedor ${n}`,
  fecha: "2026-10-05",
  moneda: "PEN",
  tipoCambio: null,
  version: 1,
  excluida: false,
  montos: {
    biDg: "100.00",
    igvDg: "18.00",
    biDgng: "0.00",
    igvDgng: "0.00",
    biDng: "0.00",
    igvDng: "0.00",
    noGravado: "0.00",
    isc: "0.00",
    icbper: "0.00",
    otrosTributos: "0.00",
    total: "118.00",
  },
  ...extra,
});

/** `leerFilasReemplazo` simulado: pasa cada compra por el callback de `previo.ts` y devuelve las filas como la lectura real. */
function filasDe(compras: ReturnType<typeof compra>[], adicionales: FilaReemplazo[] = []): void {
  vi.mocked(leerFilasReemplazo).mockImplementation((async (_tx: unknown, _c: string, _p: string, aFila: (c: unknown) => unknown) => {
    const vigente = compras.map((c) => aFila(c));
    return { original: [], vigente: [...vigente, ...adicionales] };
  }) as never);
}

const detalle = (n: number, overrides: Record<string, unknown> = {}) => ({
  raiz: "Invoice",
  identidad: { emisor: { ruc: `2010000${String(n).padStart(4, "0")}` }, tipo: "01", serie: "F001", numero: String(n) },
  fecha: "2026-10-05",
  moneda: "PEN",
  monedaUnica: true,
  totales: { gravado: "100.00", igv: "18.00", noGravado: "0.00", isc: "0.00", icbper: "0.00", total: "118.00", ...overrides },
  items: [{ descripcion: "Zapatillas deportivas" }],
});

const reglasPrepararArchivo = () => vi.mocked(prepararArchivo).mock.calls[0]![0] as unknown as {
  vigente: FilaReemplazo[];
  reglas: { diccionario: unknown; gastos?: { diccionario: unknown; umbral: number } };
};

beforeEach(() => {
  query.mockReset().mockResolvedValue({ rows: [] });
  vi.mocked(leerClienteDto).mockResolvedValue({ ruc: "20100000001", archivado: false } as never);
  vi.mocked(leerEstadoPeriodo).mockResolvedValue({ estado: "abierto", marcadoPor: null, marcadoEn: null } as never);
  vi.mocked(leerProveedoresConocidos).mockResolvedValue([] as never);
  vi.mocked(leerReglasMotor).mockResolvedValue({ filas: [], aportarCatalogo: true } as never);
  vi.mocked(leerContextoGastos).mockReset().mockResolvedValue({
    umbral: 4,
    globales: [{ palabra: "zapatillas", categoria: "ropa", excepciones: [] }],
    desactivadas: [],
    propias: [],
    ciiuCliente: null,
    ciiuProveedores: [],
    categoriasCliente: { permitidas: [], quitadas: [] },
    historial: [],
  } as never);
  vi.mocked(ultimaVersion).mockResolvedValue(null as never);
  vi.mocked(prepararArchivo).mockReset().mockReturnValue(preparado);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("calcularPrevio de compras · R-GP encendida lee el XML vigente y el contexto de gastos (027, D-5)", () => {
  it("compra con XML vigente: la fila llega a prepararArchivo con su resumen y las reglas con el contexto del estudio", async () => {
    filasDe([compra(1)]);
    query.mockResolvedValue({ rows: [{ compra_id: "c1", origen: "subido", detalle: detalle(1) }] });
    await calcularPrevio(tx, entrada);
    const { vigente, reglas } = reglasPrepararArchivo();
    expect(query).toHaveBeenCalledTimes(1);
    expect(vigente[0]!.xml).toMatchObject({
      proveedor: { tipo: "6", numero: "20100000001" },
      comprobante: { tipo: "01", serie: "F001", numero: "1" },
      glosas: ["Zapatillas deportivas"],
      fechaEmision: "2026-10-05",
    });
    expect(vigente[0]!.xml!.total.toString()).toBe("118.00");
    expect(reglas.gastos).toBeDefined();
    expect(reglas.gastos!.umbral).toBe(4);
    // El diccionario de las reglas es el efectivo del estudio (con «zapatillas»), no el base.
    expect(reglas.diccionario).toBe(reglas.gastos!.diccionario);
    expect(reglas.diccionario).not.toBe(DICCIONARIO_GLOSAS_BASE);
  });

  it("la consulta del XML vigente va con la identidad normalizada del comprobante (serie y número sin ceros) y solo de las vivas", async () => {
    filasDe([compra(7), compra(8, { excluida: true })]);
    await calcularPrevio(tx, entrada);
    const lote = JSON.parse(query.mock.calls[0]![1][0] as string) as Record<string, string>[];
    expect(lote).toHaveLength(1);
    expect(lote[0]).toMatchObject({ compra_id: "c7", cliente_id: CLIENTE, ruc: "20100000007", tipo: "01", serie: "F001", numero: "7" });
    // El contexto de gastos recibe solo los proveedores de las compras vivas (la excluida no).
    expect(vi.mocked(leerContextoGastos).mock.calls[0]![1]).toMatchObject({
      clienteId: CLIENTE,
      periodo: "202610",
      proveedores: [{ tipo: "6", numero: "20100000007" }],
    });
  });

  it("compra sin XML: la fila pasa sin `xml` (R-GP no puntúa) y las demás sí lo llevan", async () => {
    filasDe([compra(1), compra(2)]);
    query.mockResolvedValue({ rows: [{ compra_id: "c2", origen: "subido", detalle: detalle(2) }] });
    await calcularPrevio(tx, entrada);
    const { vigente } = reglasPrepararArchivo();
    expect("xml" in vigente[0]!).toBe(false);
    expect(vigente[1]!.xml).toBeDefined();
  });

  it("sin compras vivas (periodo vacío o todas excluidas): no consulta XML y el contexto va con una lista de proveedores vacía", async () => {
    filasDe([compra(1, { excluida: true })]);
    await calcularPrevio(tx, entrada);
    expect(query).not.toHaveBeenCalled();
    expect(vi.mocked(leerContextoGastos).mock.calls[0]![1]).toMatchObject({ proveedores: [] });
    expect(reglasPrepararArchivo().reglas.gastos).toBeDefined();
  });

  it("una fila de la lectura sin comprobante conocido se evalúa sin XML en vez de fallar", async () => {
    const [fila] = [compraLeidaAFila(compra(1)).fila];
    filasDe([compra(1)], [{ ...fila!, id: "huerfana" }]);
    await calcularPrevio(tx, entrada);
    const { vigente } = reglasPrepararArchivo();
    expect(vigente.map((f) => f.id)).toEqual(["c1", "huerfana"]);
    expect(JSON.parse(query.mock.calls[0]![1][0] as string)).toHaveLength(1);
  });

  it("más de 500 compras: una consulta por lote de 500", async () => {
    filasDe(Array.from({ length: 501 }, (_, i) => compra(i + 1)));
    await calcularPrevio(tx, entrada);
    expect(query).toHaveBeenCalledTimes(2);
    expect(JSON.parse(query.mock.calls[0]![1][0] as string)).toHaveLength(500);
    expect(JSON.parse(query.mock.calls[1]![1][0] as string)).toHaveLength(1);
  });

  it("un aviso del adaptador (razón social > 100) solo sale de las filas vivas; la excluida no lo aporta", async () => {
    const larga = "R".repeat(150);
    filasDe([compra(1, { razonSocial: larga }), compra(2, { razonSocial: larga, excluida: true }), compra(3)]);
    const { dto } = await calcularPrevio(tx, entrada);
    expect(dto.avisos.filter((a) => a.codigo === "RAZON_SOCIAL_RECORTADA").map((a) => a.filaId)).toEqual(["c1"]);
  });
});

describe("calcularPrevio de compras · XML simulado (016, P-4)", () => {
  const simulado = { rows: [{ compra_id: "c1", origen: "simulado", detalle: detalle(1) }] };

  it("el XML simulado NO entra a las reglas por omisión", async () => {
    filasDe([compra(1)]);
    query.mockResolvedValue(simulado);
    await calcularPrevio(tx, entrada);
    expect("xml" in reglasPrepararArchivo().vigente[0]!).toBe(false);
  });

  it("con XML_SIMULADO_EN_REGLAS=1 el simulado sí entra", async () => {
    vi.stubEnv("XML_SIMULADO_EN_REGLAS", "1");
    filasDe([compra(1)]);
    query.mockResolvedValue(simulado);
    await calcularPrevio(tx, entrada);
    expect(reglasPrepararArchivo().vigente[0]!.xml).toBeDefined();
  });

  it("cualquier otro valor de XML_SIMULADO_EN_REGLAS no lo habilita", async () => {
    vi.stubEnv("XML_SIMULADO_EN_REGLAS", "true");
    filasDe([compra(1)]);
    query.mockResolvedValue(simulado);
    await calcularPrevio(tx, entrada);
    expect("xml" in reglasPrepararArchivo().vigente[0]!).toBe(false);
  });
});

describe("calcularPrevio de compras · detalle de XML ilegible", () => {
  it("un monto ilegible (DineroError) se ignora: esa compra se evalúa sin XML y las demás no se afectan", async () => {
    filasDe([compra(1), compra(2)]);
    query.mockResolvedValue({
      rows: [
        { compra_id: "c1", origen: "subido", detalle: detalle(1, { total: "no-es-monto" }) },
        { compra_id: "c2", origen: "subido", detalle: detalle(2) },
      ],
    });
    await calcularPrevio(tx, entrada);
    const { vigente } = reglasPrepararArchivo();
    expect("xml" in vigente[0]!).toBe(false);
    expect(vigente[1]!.xml).toBeDefined();
  });

  it("un error que no es de dinero (detalle corrupto) se propaga, no se traga", async () => {
    filasDe([compra(1)]);
    query.mockResolvedValue({ rows: [{ compra_id: "c1", origen: "subido", detalle: null }] });
    await expect(calcularPrevio(tx, entrada)).rejects.toBeInstanceOf(TypeError);
  });
});

describe("calcularPrevio de compras · R-GP apagada por el estudio (021, R-8)", () => {
  it("no lee ni el XML ni el contexto: las reglas van con el diccionario base y sin `gastos`", async () => {
    vi.mocked(leerReglasMotor).mockResolvedValue({ filas: [{ codigo: "R-GP", activa: false }], aportarCatalogo: true } as never);
    filasDe([compra(1)]);
    query.mockResolvedValue({ rows: [{ compra_id: "c1", origen: "subido", detalle: detalle(1) }] });
    await calcularPrevio(tx, entrada);
    const { vigente, reglas } = reglasPrepararArchivo();
    expect(query).not.toHaveBeenCalled();
    expect(leerContextoGastos).not.toHaveBeenCalled();
    expect("xml" in vigente[0]!).toBe(false);
    expect(reglas.diccionario).toBe(DICCIONARIO_GLOSAS_BASE);
    expect("gastos" in reglas).toBe(false);
  });

  it("R-GP activa u otra regla apagada no la apaga: se lee el XML y el contexto", async () => {
    vi.mocked(leerReglasMotor).mockResolvedValue({
      filas: [
        { codigo: "R-GP", activa: true },
        { codigo: "R-ISC", activa: false },
      ],
      aportarCatalogo: true,
    } as never);
    filasDe([compra(1)]);
    await calcularPrevio(tx, entrada);
    expect(query).toHaveBeenCalledTimes(1);
    expect(leerContextoGastos).toHaveBeenCalledTimes(1);
    expect(reglasPrepararArchivo().reglas.gastos).toBeDefined();
  });
});

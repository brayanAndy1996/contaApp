// Spec 016, T17a · Unitarias de `xml.obtener` que cubren las ramas que las de integración no alcanzan: cada clase de fallo
// del proveedor con su conteo y su estado de obtención, XML ilegible o ajeno, la bandera del simulado en reglas, el XML que
// otro proceso guardó antes, la compra que dejó de aplicar al re-evaluar y la referencia que no se puede armar.
// Sin BD, Redis ni red: dobles del repositorio de `@contapp/db`, `withTenant` en memoria y el storage en memoria.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ErrorCredencial,
  ErrorDatos,
  ErrorPortal,
  ErrorTransitorio,
  type SolicitudXml,
} from "@contapp/sunat";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  leerDetalleCompra: vi.fn(),
  leerXmlVigente: vi.fn(),
  fijarObtencion: vi.fn(),
  guardarDocumentoXml: vi.fn(),
  leerProveedoresConocidos: vi.fn(),
  // 021: los interruptores del estudio; sin filas, todo encendido.
  leerReglasMotor: vi.fn(async () => ({ filas: [], aportarCatalogo: true })),
  reevaluarComprobante: vi.fn(),
}));

import {
  ComprasReglaError,
  fijarObtencion,
  guardarDocumentoXml,
  leerDetalleCompra,
  leerProveedoresConocidos,
  leerXmlVigente,
  reevaluarComprobante,
} from "@contapp/db";
import { obtenerXml, type ResultadoObtenerXml } from "./obtener-xml.js";

const TX = { tx: true };
const RUC_CLIENTE = "20700000002";
const TENANT = "11111111-1111-4111-8111-111111111111";
const CLIENTE = "33333333-3333-4333-8333-333333333333";
const PERIODO = "202610";
const ID = (n: number): string =>
  `0190a000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const XML_MIXTA = readFileSync(
  fileURLToPath(
    new URL("../../../../../fixtures/xml/20700000045-01-F001-2056.xml", import.meta.url),
  ),
  "utf8",
);

const MONTOS = {
  biDg: "8.97",
  igvDg: "1.61",
  biDgng: "0.00",
  igvDgng: "0.00",
  biDng: "12.51",
  igvDng: "0.00",
  noGravado: "0.00",
  isc: "0.00",
  icbper: "0.00",
  otrosTributos: "0.00",
  total: "23.09",
};

/** La compra F001-2056 del proveedor 20700000045 (la que describe `XML_MIXTA`), con lo que se quiera cambiar. */
const compra = (o: Record<string, unknown> = {}) => ({
  id: ID(1),
  clave: "k",
  tipoDoc: "01",
  serie: "F001",
  numero: "2056",
  docTipo: "6",
  docNumero: "20700000045",
  fecha: "2026-10-05",
  moneda: "PEN",
  tipoCambio: null,
  ...o,
});
const detalle = (c = compra(), montos: Record<string, string> = MONTOS) => ({
  compra: c,
  versiones: [{ montos }],
});

const trabajo = (compraIds: string[]) => ({
  id: "j-1",
  tenantId: TENANT,
  clienteId: CLIENTE,
  ruc: RUC_CLIENTE,
  tipo: "xml.obtener",
  parametros: { periodo: PERIODO, compraIds },
  intentos: 0,
  creadoPor: "u-1",
});

function armar(opciones: { enReglas?: boolean } = {}) {
  const withTenant = vi.fn(
    async (_estudio: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(TX),
  );
  const obtener = vi.fn();
  const guardar = vi.fn(async () => undefined);
  const eliminar = vi.fn(async () => undefined);
  const procesador = obtenerXml({
    db: { withTenant } as never,
    xmlProvider: { obtener } as never,
    storage: { guardar, leer: vi.fn(), eliminar } as never,
    ...(opciones.enReglas === undefined ? {} : { xmlSimuladoEnReglas: opciones.enReglas }),
  });
  const correr = (ids: string[]): Promise<ResultadoObtenerXml> =>
    procesador({ trabajo: trabajo(ids), conToken: vi.fn() } as never) as Promise<ResultadoObtenerXml>;
  return { withTenant, obtener, guardar, eliminar, correr };
}

const respuesta = (xml: unknown, origen = "simulado") => ({ xml, origen, fuente: "sintetico" });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(leerDetalleCompra).mockResolvedValue(detalle() as never);
  vi.mocked(leerXmlVigente).mockResolvedValue(null);
  vi.mocked(fijarObtencion).mockResolvedValue(undefined as never);
  vi.mocked(leerProveedoresConocidos).mockResolvedValue([]);
  vi.mocked(guardarDocumentoXml).mockResolvedValue({ id: "d-1", n: 1 });
  // H-016-11: el resultado trae a la compra del lote (todas las de las pruebas tienen el mismo id) entre las re-evaluadas.
  vi.mocked(reevaluarComprobante).mockResolvedValue(new Map([[ID(1), {}]]) as never);
});

const estadosAnotados = () =>
  vi.mocked(fijarObtencion).mock.calls.map((c) => c[3]);

describe("obtenerXml: qué compras se piden", () => {
  it("omite la que no existe, la de proveedor sin RUC, la de tipo sin XML y la que ya tiene XML; no llama al proveedor", async () => {
    const ids = [ID(1), ID(2), ID(3), ID(4)];
    vi.mocked(leerDetalleCompra)
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce(detalle(compra({ docTipo: "1" })) as never)
      .mockResolvedValueOnce(detalle(compra({ tipoDoc: "14" })) as never)
      .mockResolvedValueOnce(detalle() as never);
    vi.mocked(leerXmlVigente).mockResolvedValueOnce({ id: "x" } as never);
    const n = armar();
    await expect(n.correr(ids)).resolves.toEqual({
      guardados: 0,
      omitidos: 4,
      noEncontrados: 0,
      credencial: 0,
      transitorios: 0,
      invalidos: 0,
    });
    expect(n.obtener).not.toHaveBeenCalled();
    expect(n.guardar).not.toHaveBeenCalled();
    expect(fijarObtencion).not.toHaveBeenCalled();
  });

  it("omite la compra cuya versión 1 no viene en el detalle", async () => {
    vi.mocked(leerDetalleCompra).mockResolvedValueOnce({ compra: compra(), versiones: [] } as never);
    const n = armar();
    expect((await n.correr([ID(1)])).omitidos).toBe(1);
    expect(n.obtener).not.toHaveBeenCalled();
  });

  it("las lecturas van al estudio y cliente del trabajo", async () => {
    const n = armar();
    n.obtener.mockResolvedValue(respuesta(XML_MIXTA));
    await n.correr([ID(1)]);
    expect(n.withTenant.mock.calls[0]?.[0]).toEqual({ tenantId: TENANT });
    expect(vi.mocked(leerDetalleCompra).mock.calls[0]?.slice(1)).toEqual([CLIENTE, PERIODO, ID(1)]);
  });
});

describe("obtenerXml: fallos del proveedor", () => {
  it.each([
    ["ErrorDatos", () => new ErrorDatos(), "noEncontrados", "no_encontrado"],
    ["ErrorPortal", () => new ErrorPortal(), "noEncontrados", "no_encontrado"],
    ["ErrorCredencial", () => new ErrorCredencial(), "credencial", "credencial"],
  ] as const)(
    "%s: cuenta en %s, anota %s, no guarda nada y el trabajo termina bien (sin reintento)",
    async (_nombre, error, contador, estado) => {
      const n = armar();
      n.obtener.mockRejectedValue(error());
      const r = await n.correr([ID(1)]);
      expect(r).toEqual({
        guardados: 0,
        omitidos: 0,
        noEncontrados: 0,
        credencial: 0,
        transitorios: 0,
        invalidos: 0,
        [contador]: 1,
      });
      expect(estadosAnotados()).toEqual([estado]);
      expect(n.guardar).not.toHaveBeenCalled();
      expect(guardarDocumentoXml).not.toHaveBeenCalled();
      expect(reevaluarComprobante).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["ErrorTransitorio", () => new ErrorTransitorio()],
    ["un error desconocido", () => new Error("boom")],
  ])("%s: anota transitorio y, al terminar el lote, lanza ErrorTransitorio para que 008 reintente", async (_n, error) => {
    const n = armar();
    n.obtener.mockRejectedValue(error());
    await expect(n.correr([ID(1)])).rejects.toBeInstanceOf(ErrorTransitorio);
    expect(estadosAnotados()).toEqual(["transitorio"]);
    expect(n.guardar).not.toHaveBeenCalled();
  });

  it("un transitorio no frena al resto del lote: lo guardado antes y después se conserva y el error sale al final", async () => {
    vi.mocked(leerDetalleCompra).mockResolvedValue(detalle() as never);
    const n = armar();
    n.obtener
      .mockResolvedValueOnce(respuesta(XML_MIXTA))
      .mockRejectedValueOnce(new ErrorTransitorio())
      .mockResolvedValueOnce(respuesta(XML_MIXTA));
    await expect(n.correr([ID(1), ID(2), ID(3)])).rejects.toBeInstanceOf(ErrorTransitorio);
    expect(n.obtener).toHaveBeenCalledTimes(3);
    expect(guardarDocumentoXml).toHaveBeenCalledTimes(2);
    expect(estadosAnotados()).toEqual(["transitorio"]);
  });

  it("el error del proveedor no se propaga ni su mensaje llega al resultado", async () => {
    const n = armar();
    n.obtener.mockRejectedValue(new ErrorCredencial(new Error("CANARIO-SECRETO")));
    const r = await n.correr([ID(1)]);
    expect(JSON.stringify(r)).not.toContain("CANARIO-SECRETO");
  });
});

describe("obtenerXml: XML inválido o ajeno", () => {
  const AJENO_RECEPTOR = XML_MIXTA.replace('schemeID="6">20700000002<', 'schemeID="6">20700000099<');
  const AJENO_SERIE = XML_MIXTA.replace("<cbc:ID>F001-2056</cbc:ID>", "<cbc:ID>F002-2056</cbc:ID>");
  const LATIN1_CON_EMOJI = XML_MIXTA.replace('encoding="UTF-8"', 'encoding="ISO-8859-1"').replace(
    "(PRUEBA)",
    "(PRUEBA) \u{1F600}",
  );

  it.each([
    ["texto que no es XML", "esto no es un comprobante"],
    ["cadena vacía", ""],
    ["respuesta sin texto (no es string)", undefined],
    ["declara ISO-8859-1 pero trae caracteres fuera de él", LATIN1_CON_EMOJI],
    ["ajeno: otro receptor", AJENO_RECEPTOR],
    ["ajeno: otra serie", AJENO_SERIE],
  ])("%s: cuenta invalido, anota no_encontrado y no escribe en storage ni en BD", async (_nombre, xml) => {
    const n = armar({ enReglas: true });
    n.obtener.mockResolvedValue(respuesta(xml));
    const r = await n.correr([ID(1)]);
    expect(r).toEqual({
      guardados: 0,
      omitidos: 0,
      noEncontrados: 0,
      credencial: 0,
      transitorios: 0,
      invalidos: 1,
    });
    expect(estadosAnotados()).toEqual(["no_encontrado"]);
    expect(n.guardar).not.toHaveBeenCalled();
    expect(guardarDocumentoXml).not.toHaveBeenCalled();
    expect(reevaluarComprobante).not.toHaveBeenCalled();
  });
});

describe("obtenerXml: guardado y bandera del simulado en reglas (P-4)", () => {
  it("con la bandera apagada el XML simulado se guarda (storage y BD) pero no re-evalúa", async () => {
    const n = armar({ enReglas: false });
    n.obtener.mockResolvedValue(respuesta(XML_MIXTA, "simulado"));
    const r = await n.correr([ID(1)]);
    expect(r.guardados).toBe(1);
    expect(n.guardar).toHaveBeenCalledTimes(1);
    expect(guardarDocumentoXml).toHaveBeenCalledTimes(1);
    expect(reevaluarComprobante).not.toHaveBeenCalled();
    expect(leerProveedoresConocidos).not.toHaveBeenCalled();
  });

  it("sin la dependencia de la bandera también queda apagada", async () => {
    const n = armar();
    n.obtener.mockResolvedValue(respuesta(XML_MIXTA, "simulado"));
    await n.correr([ID(1)]);
    expect(reevaluarComprobante).not.toHaveBeenCalled();
  });

  it("con la bandera encendida el XML simulado re-evalúa todas las compras vivas del comprobante en la misma transacción (H-016-11)", async () => {
    const n = armar({ enReglas: true });
    n.obtener.mockResolvedValue(respuesta(XML_MIXTA, "simulado"));
    const r = await n.correr([ID(1)]);
    expect(r.guardados).toBe(1);
    expect(reevaluarComprobante).toHaveBeenCalledTimes(1);
    const [tx, clienteId, identidad, opciones] = vi.mocked(reevaluarComprobante).mock.calls[0] as unknown as [
      unknown,
      string,
      unknown,
      { evaluarDe: (periodo: string) => Promise<unknown>; bloqueo: string; excluir?: unknown },
    ];
    expect(tx).toBe(TX);
    expect(clienteId).toBe(CLIENTE);
    // La identidad del comprobante (no el id de la compra) y la función acotada del worker, que no hace UPDATE sobre compra.
    expect(identidad).toEqual({ rucEmisor: "20700000045", tipo: "01", serie: "F001", numero: "2056" });
    expect(opciones.bloqueo).toBe("funcion");
    expect(opciones.excluir).toBeUndefined();
    // Cada compra se evalúa con el historial de proveedores de SU periodo.
    expect(leerProveedoresConocidos).not.toHaveBeenCalled();
    expect(typeof (await opciones.evaluarDe("202609"))).toBe("function");
    expect(vi.mocked(leerProveedoresConocidos).mock.calls[0]?.slice(1)).toEqual([CLIENTE, "202609"]);
  });

  it.each(["real", "subido"])(
    "un XML de origen %s re-evalúa aunque la bandera esté apagada",
    async (origen) => {
      const n = armar({ enReglas: false });
      n.obtener.mockResolvedValue(respuesta(XML_MIXTA, origen));
      await n.correr([ID(1)]);
      expect(reevaluarComprobante).toHaveBeenCalledTimes(1);
    },
  );

  it("guarda los bytes tal cual con su sha256 y tamaño, bajo xml/{tenant}/{cliente}/ y con el origen del proveedor", async () => {
    const n = armar();
    n.obtener.mockResolvedValue(respuesta(XML_MIXTA));
    await n.correr([ID(1)]);
    const [ruta, bytes] = n.guardar.mock.calls[0] as unknown as [string, Uint8Array];
    expect(ruta.startsWith(`xml/${TENANT}/${CLIENTE}/`)).toBe(true);
    expect(ruta.endsWith(".xml")).toBe(true);
    expect(Buffer.from(bytes).toString("utf8")).toBe(XML_MIXTA);
    const entrada = vi.mocked(guardarDocumentoXml).mock.calls[0]?.[1] as unknown as Record<string, unknown>;
    expect(entrada).toMatchObject({
      clienteId: CLIENTE,
      rucEmisor: "20700000045",
      tipo: "01",
      serie: "F001",
      numero: "2056",
      origen: "simulado",
      ruta,
      tamano: bytes.length,
    });
    expect(Buffer.from(entrada.sha256 as Uint8Array).equals(createHash("sha256").update(bytes).digest())).toBe(true);
  });

  it("un XML que declara ISO-8859-1 se guarda en esa codificación (byte 0xF1 para la ñ), no reencodado a UTF-8", async () => {
    const latin1 = XML_MIXTA.replace('encoding="UTF-8"', 'encoding="ISO-8859-1"').replace("(PRUEBA)", "(PRUEBA) ñ");
    const n = armar();
    n.obtener.mockResolvedValue(respuesta(latin1));
    const r = await n.correr([ID(1)]);
    expect(r.guardados).toBe(1);
    const bytes = Buffer.from((n.guardar.mock.calls[0] as unknown as [string, Uint8Array])[1]);
    expect(bytes.includes(0xf1)).toBe(true);
    expect(bytes.includes(Buffer.from([0xc3, 0xb1]))).toBe(false);
    expect(bytes.equals(Buffer.from(latin1, "latin1"))).toBe(true);
  });
});

describe("obtenerXml: el XML que otro proceso guardó antes", () => {
  it("existente_no_simulado: cuenta omitido, borra el archivo recién subido y no re-evalúa", async () => {
    vi.mocked(guardarDocumentoXml).mockResolvedValue("existente_no_simulado");
    const n = armar({ enReglas: true });
    n.obtener.mockResolvedValue(respuesta(XML_MIXTA));
    const r = await n.correr([ID(1)]);
    expect(r).toMatchObject({ guardados: 0, omitidos: 1 });
    const ruta = (n.guardar.mock.calls[0] as unknown as [string])[0];
    expect(n.eliminar).toHaveBeenCalledWith(ruta);
    expect(reevaluarComprobante).not.toHaveBeenCalled();
  });

  it("si el borrado del archivo sobrante falla, el trabajo igual termina bien", async () => {
    vi.mocked(guardarDocumentoXml).mockResolvedValue("existente_no_simulado");
    const n = armar();
    n.eliminar.mockRejectedValue(new Error("storage caído"));
    n.obtener.mockResolvedValue(respuesta(XML_MIXTA));
    await expect(n.correr([ID(1)])).resolves.toMatchObject({ omitidos: 1 });
  });
});

describe("obtenerXml: la compra dejó de aplicar al re-evaluar", () => {
  it("la compra del lote ya no está entre las vivas del comprobante: revierte la transacción, borra el archivo de storage, cuenta omitido y sigue con la siguiente compra", async () => {
    // La primera compra no figura entre las re-evaluadas (se descartó mientras tanto); la segunda sí.
    vi.mocked(reevaluarComprobante)
      .mockResolvedValueOnce(new Map() as never)
      .mockResolvedValueOnce(new Map([[ID(1), {}]]) as never);
    const n = armar({ enReglas: true });
    n.obtener.mockResolvedValue(respuesta(XML_MIXTA));
    const r = await n.correr([ID(1), ID(2)]);
    expect(r).toMatchObject({ guardados: 1, omitidos: 1, invalidos: 0, transitorios: 0 });
    expect(n.guardar).toHaveBeenCalledTimes(2);
    const primera = (n.guardar.mock.calls[0] as unknown as [string])[0];
    const segunda = (n.guardar.mock.calls[1] as unknown as [string])[0];
    expect(n.eliminar).toHaveBeenCalledTimes(1);
    expect(n.eliminar).toHaveBeenCalledWith(primera);
    expect(n.eliminar).not.toHaveBeenCalledWith(segunda);
  });

  it("la excepción sale del callback de withTenant (así la transacción se revierte): no se confirma ni el documento ni la re-evaluación", async () => {
    vi.mocked(reevaluarComprobante).mockResolvedValueOnce(new Map() as never);
    const n = armar({ enReglas: true });
    const salidas: Array<"confirmada" | "revertida"> = [];
    n.withTenant.mockImplementation(async (_e, fn) => {
      try {
        const r = await fn(TX);
        salidas.push("confirmada");
        return r;
      } catch (e) {
        salidas.push("revertida");
        throw e;
      }
    });
    n.obtener.mockResolvedValue(respuesta(XML_MIXTA));
    await n.correr([ID(1)]);
    // lectura (confirmada) y la escritura del documento con la re-evaluación (revertida).
    expect(salidas).toEqual(["confirmada", "revertida"]);
  });

  it("otra regla de compras (no no_encontrada) no se traga: borra el archivo y el trabajo falla con ese error", async () => {
    const regla = new ComprasReglaError("version_desfasada");
    vi.mocked(reevaluarComprobante).mockRejectedValueOnce(regla);
    const n = armar({ enReglas: true });
    n.obtener.mockResolvedValue(respuesta(XML_MIXTA));
    await expect(n.correr([ID(1), ID(2)])).rejects.toBe(regla);
    expect(n.eliminar).toHaveBeenCalledTimes(1);
    expect(n.obtener).toHaveBeenCalledTimes(1);
  });

  it("un error cualquiera de la BD al guardar tampoco se traga: borra el archivo y se propaga", async () => {
    const fallo = new Error("bd caída");
    vi.mocked(guardarDocumentoXml).mockRejectedValueOnce(fallo);
    const n = armar();
    n.obtener.mockResolvedValue(respuesta(XML_MIXTA));
    await expect(n.correr([ID(1)])).rejects.toBe(fallo);
    expect(n.eliminar).toHaveBeenCalledTimes(1);
  });

  it("si además el borrado falla, el error original es el que sale", async () => {
    const fallo = new Error("bd caída");
    vi.mocked(guardarDocumentoXml).mockRejectedValueOnce(fallo);
    const n = armar();
    n.eliminar.mockRejectedValue(new Error("storage caído"));
    n.obtener.mockResolvedValue(respuesta(XML_MIXTA));
    await expect(n.correr([ID(1)])).rejects.toBe(fallo);
  });
});

describe("obtenerXml: la referencia que recibe el proveedor", () => {
  const solicitud = (n: { obtener: ReturnType<typeof vi.fn> }): SolicitudXml =>
    n.obtener.mock.calls[0]?.[0] as SolicitudXml;

  it("PEN: fecha, totales de la versión 1 sumados por tipo, RUC del cliente como receptor y sin tipo de cambio", async () => {
    const n = armar();
    n.obtener.mockResolvedValue(respuesta(XML_MIXTA));
    await n.correr([ID(1)]);
    expect(solicitud(n)).toEqual({
      rucEmisor: "20700000045",
      tipo: "01",
      serie: "F001",
      numero: "2056",
      referencia: {
        fechaEmision: "2026-10-05",
        moneda: "PEN",
        baseGravada: "21.48",
        igv: "1.61",
        noGravado: "0.00",
        isc: "0.00",
        icbper: "0.00",
        otros: "0.00",
        total: "23.09",
        rucReceptor: RUC_CLIENTE,
      },
    });
  });

  it("USD: la referencia lleva el tipo de cambio de la compra", async () => {
    vi.mocked(leerDetalleCompra).mockResolvedValue(
      detalle(compra({ moneda: "USD", tipoCambio: "3.752" })) as never,
    );
    const n = armar();
    n.obtener.mockResolvedValue(respuesta(XML_MIXTA));
    await n.correr([ID(1)]);
    expect(solicitud(n).referencia).toMatchObject({ moneda: "USD", tipoCambio: "3.752" });
  });

  it("si los montos no se pueden leer, la solicitud va sin referencia (el proveedor real la ignora) y el lote sigue", async () => {
    vi.mocked(leerDetalleCompra).mockResolvedValue(
      detalle(compra(), { ...MONTOS, biDg: "no-es-un-monto" }) as never,
    );
    const n = armar();
    n.obtener.mockResolvedValue(respuesta(XML_MIXTA));
    const r = await n.correr([ID(1)]);
    expect(solicitud(n)).not.toHaveProperty("referencia");
    expect(r.guardados).toBe(1);
  });
});

describe("obtenerXml: el proveedor se llama fuera de toda transacción (008 D6)", () => {
  it("al pedir el XML no hay ningún withTenant abierto", async () => {
    let abiertas = 0;
    const n = armar();
    n.withTenant.mockImplementation(async (_e, fn) => {
      abiertas += 1;
      try {
        return await fn(TX);
      } finally {
        abiertas -= 1;
      }
    });
    let abiertasAlPedir = -1;
    n.obtener.mockImplementation(async () => {
      abiertasAlPedir = abiertas;
      return respuesta(XML_MIXTA);
    });
    await n.correr([ID(1)]);
    expect(abiertasAlPedir).toBe(0);
  });
});

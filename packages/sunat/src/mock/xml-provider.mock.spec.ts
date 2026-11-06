import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  clasificarError,
  ErrorCredencial,
  ErrorDatos,
  ErrorTransitorio,
} from "../errores.js";
import type { ReferenciaXml, SolicitudXml, XmlProvider } from "../puertos.js";
import { MockXmlProvider } from "./xml-provider.mock.js";
import { TOPE_BYTES_FIXTURE } from "./ruta-fixture.js";

// Spec 009 (D3-D6; CA-1, CA-3, CA-4). Todas las pruebas usan un directorio temporal de fixtures propio,
// salvo la primera, que lee un fixture real del repo (fixtures/xml) con la ruta por defecto.
const RUC = "20700000011";
const base = { rucEmisor: RUC, tipo: "01", serie: "F001" };
const sol = (
  numero: string,
  extra: Partial<SolicitudXml> = {},
): SolicitudXml => ({
  ...base,
  numero,
  ...extra,
});
const REF: ReferenciaXml = {
  fechaEmision: "2026-10-05",
  moneda: "PEN",
  baseGravada: "100.00",
  igv: "18.00",
  noGravado: "0.00",
  isc: "0.00",
  icbper: "0.00",
  otros: "0.00",
  total: "118.00",
};
const XML_FIXTURE = "<Invoice><!-- fixture temporal --></Invoice>";

let raiz: string;
let dir: string;
let fuera: string;

beforeAll(() => {
  raiz = mkdtempSync(join(tmpdir(), "xml-mock-"));
  dir = join(raiz, "xml");
  fuera = join(raiz, "fuera");
  mkdirSync(dir);
  mkdirSync(fuera);
  writeFileSync(join(dir, `${RUC}-01-F001-1040.xml`), XML_FIXTURE);
  writeFileSync(join(fuera, "secreto.xml"), "CONTENIDO-FUERA-DE-LA-CARPETA");
  symlinkSync(join(fuera, "secreto.xml"), join(dir, `${RUC}-01-F001-2050.xml`));
  writeFileSync(
    join(dir, `${RUC}-01-F001-3060.xml`),
    "x".repeat(TOPE_BYTES_FIXTURE + 1),
  );
});
afterAll(() => rmSync(raiz, { recursive: true, force: true }));

async function atrapar(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("se esperaba un error");
}

describe("MockXmlProvider · fixture y sintético (CA-1)", () => {
  it("implementa el puerto y devuelve el fixture real del repo con origen simulado", async () => {
    const puerto: XmlProvider = new MockXmlProvider();
    const r = await puerto.obtener(sol("1040"));
    expect(r.origen).toBe("simulado");
    expect(r.fuente).toBe("fixture");
    expect(r.xml).toContain("<cbc:ID>F001-1040</cbc:ID>");
  });

  it("devuelve el contenido del fixture del directorio indicado", async () => {
    const r = await new MockXmlProvider({ dirFixtures: dir }).obtener(
      sol("1040"),
    );
    expect(r).toEqual({
      xml: XML_FIXTURE,
      origen: "simulado",
      fuente: "fixture",
    });
  });

  it("sin fixture y con referencia genera un UBL con los totales de la fila", async () => {
    const r = await new MockXmlProvider({ dirFixtures: dir }).obtener(
      sol("55", { referencia: REF }),
    );
    expect(r.origen).toBe("simulado");
    expect(r.fuente).toBe("sintetico");
    expect(r.xml).toContain("<cbc:ID>F001-55</cbc:ID>");
    expect(r.xml).toContain(
      "<cbc:DocumentCurrencyCode>PEN</cbc:DocumentCurrencyCode>",
    );
    expect(r.xml).toContain(
      '<cbc:PayableAmount currencyID="PEN">118.00</cbc:PayableAmount>',
    );
    expect(r.xml).toContain(
      '<cbc:TaxAmount currencyID="PEN">18.00</cbc:TaxAmount>',
    );
    expect(r.xml).toContain(
      '<cbc:LineExtensionAmount currencyID="PEN">100.00</cbc:LineExtensionAmount>',
    );
    expect(r.xml).toContain("<cbc:ID>1000</cbc:ID>");
  });

  it("en USD con tipo de cambio, ISC e ICBPER incluye los tributos y el tipo de cambio", async () => {
    const r = await new MockXmlProvider({ dirFixtures: dir }).obtener(
      sol("56", {
        referencia: {
          ...REF,
          moneda: "USD",
          tipoCambio: "3.300",
          isc: "5.00",
          icbper: "1.50",
          noGravado: "2.00",
          total: "126.50",
        },
      }),
    );
    expect(r.xml).toContain("<cbc:CalculationRate>3.300</cbc:CalculationRate>");
    expect(r.xml).toContain("<cbc:ID>2000</cbc:ID>");
    expect(r.xml).toContain("<cbc:ID>7152</cbc:ID>");
    expect(r.xml).toContain("<cbc:ID>9997</cbc:ID>");
    // 18.00 + 5.00 + 1.50 de tributos; valor de venta 100.00 + 2.00.
    expect(r.xml).toContain(
      '<cbc:TaxAmount currencyID="USD">24.50</cbc:TaxAmount>',
    );
    expect(r.xml).toContain(
      '<cbc:LineExtensionAmount currencyID="USD">102.00</cbc:LineExtensionAmount>',
    );
  });

  it("una referencia con monto inválido da ErrorDatos sin eco del valor", async () => {
    const e = await atrapar(
      new MockXmlProvider({ dirFixtures: dir }).obtener(
        sol("55", { referencia: { ...REF, total: "1e3-SECRETO" } }),
      ),
    );
    expect(e).toBeInstanceOf(ErrorDatos);
    expect(JSON.stringify(e) + String((e as Error).stack)).not.toContain(
      "SECRETO",
    );
  });
});

describe("MockXmlProvider · sin fixture ni referencia (CA-3)", () => {
  it("lanza ErrorDatos", async () => {
    const e = await atrapar(
      new MockXmlProvider({ dirFixtures: dir }).obtener(sol("55")),
    );
    expect(e).toBeInstanceOf(ErrorDatos);
    expect(clasificarError(e).clase).toBe("datos");
  });
});

describe("MockXmlProvider · fallar (CA-3)", () => {
  it.each([
    ["no_encontrado", ErrorDatos, "datos"],
    ["timeout", ErrorTransitorio, "transitorio"],
    ["credencial", ErrorCredencial, "credencial"],
  ] as const)(
    "fallar(%s) lanza el error clasificable",
    async (modo, Clase, clase) => {
      const mock = new MockXmlProvider({ dirFixtures: dir });
      mock.fallar(modo);
      const e = await atrapar(mock.obtener(sol("1040")));
      expect(e).toBeInstanceOf(Clase);
      expect(clasificarError(e).clase).toBe(clase);
    },
  );

  it("con veces: n falla n llamadas y luego resuelve; fallar(null) lo apaga", async () => {
    const mock = new MockXmlProvider({ dirFixtures: dir });
    mock.fallar("timeout", { veces: 2 });
    await atrapar(mock.obtener(sol("1040")));
    await atrapar(mock.obtener(sol("1040")));
    expect((await mock.obtener(sol("1040"))).fuente).toBe("fixture");
    mock.fallar("credencial");
    mock.fallar(null);
    expect((await mock.obtener(sol("1040"))).fuente).toBe("fixture");
  });

  it("timeout espera la latencia configurada antes de fallar", async () => {
    const mock = new MockXmlProvider({ dirFixtures: dir, latenciaMs: 60 });
    mock.fallar("timeout");
    const t0 = Date.now();
    await atrapar(mock.obtener(sol("1040")));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(50);
  });

  it("sin latencia configurada responde sin esperar", async () => {
    const mock = new MockXmlProvider({ dirFixtures: dir });
    const t0 = Date.now();
    await mock.obtener(sol("1040"));
    expect(Date.now() - t0).toBeLessThan(50);
  });
});

describe("MockXmlProvider · centinelas por último dígito del número", () => {
  it.each([
    ["57", ErrorTransitorio, "transitorio"],
    ["58", ErrorDatos, "datos"],
    ["59", ErrorCredencial, "credencial"],
  ] as const)("número terminado en %s", async (numero, Clase, clase) => {
    const e = await atrapar(
      new MockXmlProvider({ dirFixtures: dir }).obtener(
        sol(numero, { referencia: REF }),
      ),
    );
    expect(e).toBeInstanceOf(Clase);
    expect(clasificarError(e).clase).toBe(clase);
  });

  it("otro final resuelve con la referencia", async () => {
    const r = await new MockXmlProvider({ dirFixtures: dir }).obtener(
      sol("56", { referencia: REF }),
    );
    expect(r.fuente).toBe("sintetico");
  });
});

describe("MockXmlProvider · inyectar", () => {
  it("fuerza un XML con fuente inyectado, por encima del fixture", async () => {
    const mock = new MockXmlProvider({ dirFixtures: dir });
    mock.inyectar(`${RUC}-01-F001-1040`, { xml: "<X/>" });
    expect(await mock.obtener(sol("1040"))).toEqual({
      xml: "<X/>",
      origen: "simulado",
      fuente: "inyectado",
    });
  });

  it("fuerza un error y rechaza una clave fuera de la gramática", async () => {
    const mock = new MockXmlProvider({ dirFixtures: dir });
    mock.inyectar(`${RUC}-01-F001-1040`, { error: new ErrorCredencial() });
    expect(await atrapar(mock.obtener(sol("1040")))).toBeInstanceOf(
      ErrorCredencial,
    );
    expect(() => mock.inyectar("../etc/passwd", { xml: "<X/>" })).toThrow(
      ErrorDatos,
    );
  });
});

describe("MockXmlProvider · registro", () => {
  it("anota clave, resultado y fuente, sin contenido ni la entrada inválida", async () => {
    const mock = new MockXmlProvider({ dirFixtures: dir });
    await mock.obtener(sol("1040"));
    await atrapar(mock.obtener(sol("55")));
    await atrapar(mock.obtener({ ...sol("55"), serie: "../../SECRETO" }));
    const reg = mock.registro();
    expect(reg).toEqual([
      { clave: `${RUC}-01-F001-1040`, resultado: "ok", fuente: "fixture" },
      { clave: `${RUC}-01-F001-55`, resultado: "error", clase: "datos" },
      { clave: null, resultado: "error", clase: "datos" },
    ]);
    expect(JSON.stringify(reg)).not.toContain("fixture temporal");
    expect(JSON.stringify(reg)).not.toContain("SECRETO");
  });
});

describe("MockXmlProvider · seguridad de ruta (CA-4)", () => {
  const casos: Array<[string, Partial<SolicitudXml>]> = [
    ["serie con ../", { serie: "../.." }],
    ["serie con minúsculas", { serie: "f001" }],
    ["serie de 5 caracteres", { serie: "F0011" }],
    ["serie con separador", { serie: "F/01" }],
    ["número con ../", { numero: "../1" }],
    ["número de 9 dígitos", { numero: "123456789" }],
    ["número vacío", { numero: "" }],
    ["número no numérico", { numero: "12a" }],
    ["ruta absoluta en el RUC", { rucEmisor: "/etc/passwd" }],
    ["ruta absoluta en la serie", { serie: "/tmp" }],
    ["RUC de 10 dígitos", { rucEmisor: "2070000001" }],
    ["tipo de 3 dígitos", { tipo: "001" }],
    ["salto de línea final", { numero: "1040\n" }],
    ["byte nulo", { numero: "1040\0" }],
  ];

  it.each(casos)("rechaza %s con ErrorDatos", async (_nombre, cambio) => {
    const mock = new MockXmlProvider({ dirFixtures: dir });
    const e = await atrapar(
      mock.obtener({ ...sol("1040"), ...cambio, referencia: REF }),
    );
    expect(e).toBeInstanceOf(ErrorDatos);
  });

  it("un enlace simbólico que sale de la carpeta da ErrorDatos sin leer fuera", async () => {
    const mock = new MockXmlProvider({ dirFixtures: dir });
    const e = await atrapar(mock.obtener(sol("2050", { referencia: REF })));
    expect(e).toBeInstanceOf(ErrorDatos);
    expect(JSON.stringify(e) + String((e as Error).stack)).not.toContain(
      "CONTENIDO-FUERA",
    );
    expect(JSON.stringify(mock.registro())).not.toContain("CONTENIDO-FUERA");
  });

  it("un fixture por encima del tope de tamaño da ErrorDatos", async () => {
    const e = await atrapar(
      new MockXmlProvider({ dirFixtures: dir }).obtener(sol("3060")),
    );
    expect(e).toBeInstanceOf(ErrorDatos);
  });

  it("una carpeta de fixtures inexistente se trata como sin fixture", async () => {
    const mock = new MockXmlProvider({ dirFixtures: join(raiz, "no-existe") });
    expect((await mock.obtener(sol("1040", { referencia: REF }))).fuente).toBe(
      "sintetico",
    );
  });
});

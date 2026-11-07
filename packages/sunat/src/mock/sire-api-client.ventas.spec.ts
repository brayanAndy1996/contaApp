import { describe, expect, expectTypeOf, it } from "vitest";
import { clasificarError } from "../errores.js";
import type {
  FilaPropuestaSire,
  FilaVentaSire,
  PropuestaComprasSire,
  PropuestaSire,
  PropuestaVentasSire,
  TokenSire,
} from "../puertos.js";
import { MockSireApiClient } from "./sire-api-client.mock.js";

// Spec 013 (D2, D12, D14b; CA-1, CA-2). Contrato fijado por estas pruebas (plan: Contratos, Puertos):
//  - `FilaVentaSire { tipo, serie, numero, tipoDocContraparte?, docContraparte, fechaEmision, moneda,
//    tipoCambio?, baseGravada, igv, exonerada, inafecta, isc, icbper, otros, total }`, montos como cadenas.
//  - `PropuestaVentasSire { libro: "ventas"; periodo; filas: FilaVentaSire[] }` y
//    `PropuestaComprasSire { libro: "compras"; periodo; filas: FilaPropuestaSire[] }`.
//  - `PropuestaSire = PropuestaComprasSire | PropuestaVentasSire`: se estrecha por `libro`.
//  - `FilaPropuestaSire` y la propuesta de compras no cambian (014 no se rompe).
// Las pruebas de tipos se comprueban con `pnpm --filter @contapp/sunat typecheck` (vitest no verifica tipos);
// las de datos corren con el mock y los fixtures de T1 (`fixtures/sire/`).
const RUC = "20700000002";
const AJENO = "20100000001";
const TOKEN: TokenSire = { token: "token-de-prueba", expiraEn: new Date("2026-10-27T16:00:00Z") };
const pedir = (ruc: string, periodo: string, libro: "compras" | "ventas") => ({ ruc, periodo, libro });

const OBLIGATORIAS = [
  "tipo",
  "serie",
  "numero",
  "docContraparte",
  "fechaEmision",
  "moneda",
  "baseGravada",
  "igv",
  "exonerada",
  "inafecta",
  "isc",
  "icbper",
  "otros",
  "total",
] as const;
const OPCIONALES = ["tipoDocContraparte", "tipoCambio"] as const;
const MONTOS = ["baseGravada", "igv", "exonerada", "inafecta", "isc", "icbper", "otros", "total"] as const;
const COLUMNAS_DE_COMPRAS = ["rucContraparte", "biDg", "igvDg", "biDgng", "igvDgng", "biDng", "igvDng", "noGravado"];

async function ventas(ruc: string, periodo: string, mock = new MockSireApiClient()): Promise<PropuestaVentasSire> {
  const p: PropuestaSire = await mock.descargarPropuesta(TOKEN, pedir(ruc, periodo, "ventas"));
  if (p.libro !== "ventas") throw new Error("se esperaba la propuesta de ventas");
  return p;
}
const clave = (f: { tipo: string; serie: string; numero: string }) => `${f.tipo}-${f.serie}-${f.numero}`;

describe("tipos del puerto (013, D12): se verifican con typecheck", () => {
  it("FilaVentaSire lleva los 8 montos como cadenas y los dos opcionales", () => {
    expectTypeOf<FilaVentaSire["baseGravada"]>().toEqualTypeOf<string>();
    expectTypeOf<FilaVentaSire["igv"]>().toEqualTypeOf<string>();
    expectTypeOf<FilaVentaSire["exonerada"]>().toEqualTypeOf<string>();
    expectTypeOf<FilaVentaSire["inafecta"]>().toEqualTypeOf<string>();
    expectTypeOf<FilaVentaSire["isc"]>().toEqualTypeOf<string>();
    expectTypeOf<FilaVentaSire["icbper"]>().toEqualTypeOf<string>();
    expectTypeOf<FilaVentaSire["otros"]>().toEqualTypeOf<string>();
    expectTypeOf<FilaVentaSire["total"]>().toEqualTypeOf<string>();
    expectTypeOf<FilaVentaSire["docContraparte"]>().toEqualTypeOf<string>();
    expectTypeOf<FilaVentaSire["moneda"]>().toEqualTypeOf<"PEN" | "USD">();
    const sinOpcionales: FilaVentaSire = {
      tipo: "03",
      serie: "B001",
      numero: "290",
      docContraparte: "-",
      fechaEmision: "2026-10-03",
      moneda: "PEN",
      baseGravada: "100.00",
      igv: "18.00",
      exonerada: "0.00",
      inafecta: "0.00",
      isc: "0.00",
      icbper: "0.00",
      otros: "0.00",
      total: "118.00",
    };
    expect(sinOpcionales.tipoCambio).toBeUndefined();
    expect(sinOpcionales.tipoDocContraparte).toBeUndefined();
  });

  it("FilaVentaSire no admite montos numéricos ni las columnas de compras", () => {
    const base = {
      tipo: "03",
      serie: "B001",
      numero: "290",
      docContraparte: "-",
      fechaEmision: "2026-10-03",
      moneda: "PEN",
      baseGravada: "100.00",
      igv: "18.00",
      exonerada: "0.00",
      inafecta: "0.00",
      isc: "0.00",
      icbper: "0.00",
      otros: "0.00",
      total: "118.00",
    } as const;
    // @ts-expect-error el monto es una cadena decimal, nunca `number`
    const numerico: FilaVentaSire = { ...base, total: 118 };
    // @ts-expect-error `biDg` es una columna de compras
    const conCompras: FilaVentaSire = { ...base, biDg: "100.00" };
    // @ts-expect-error `rucContraparte` es de compras: ventas usa `docContraparte`
    const conRuc: FilaVentaSire = { ...base, rucContraparte: "20700000011" };
    expect([numerico, conCompras, conRuc]).toHaveLength(3);
  });

  it("PropuestaSire es la unión por `libro` y FilaPropuestaSire queda para compras", () => {
    expectTypeOf<PropuestaSire>().toEqualTypeOf<PropuestaComprasSire | PropuestaVentasSire>();
    expectTypeOf<PropuestaVentasSire["libro"]>().toEqualTypeOf<"ventas">();
    expectTypeOf<PropuestaVentasSire["filas"]>().toEqualTypeOf<FilaVentaSire[]>();
    expectTypeOf<PropuestaComprasSire["libro"]>().toEqualTypeOf<"compras">();
    expectTypeOf<PropuestaComprasSire["filas"]>().toEqualTypeOf<FilaPropuestaSire[]>();
    expectTypeOf<PropuestaVentasSire["periodo"]>().toEqualTypeOf<string>();
  });

  it("estrechar por `libro` da las filas de cada libro", () => {
    const filasDe = (p: PropuestaSire): number => {
      if (p.libro === "ventas") {
        const filas: FilaVentaSire[] = p.filas;
        return filas.filter((f) => f.baseGravada !== undefined).length;
      }
      const filas: FilaPropuestaSire[] = p.filas;
      return filas.filter((f) => f.biDg !== undefined).length;
    };
    expect(filasDe({ libro: "ventas", periodo: "202610", filas: [] })).toBe(0);
    expect(filasDe({ libro: "compras", periodo: "202610", filas: [] })).toBe(0);
  });

  it("una propuesta de ventas con filas de compras (o al revés) no compila", () => {
    const deCompras: FilaPropuestaSire[] = [];
    const deVentas: FilaVentaSire[] = [];
    // @ts-expect-error las filas de ventas no son las de compras
    const mala: PropuestaVentasSire = { libro: "ventas", periodo: "202610", filas: deCompras };
    // @ts-expect-error las filas de compras no son las de ventas
    const mala2: PropuestaComprasSire = { libro: "compras", periodo: "202610", filas: deVentas };
    expect([mala, mala2]).toHaveLength(2);
  });
});

describe("MockSireApiClient ventas: fixture del contribuyente de prueba (CA-1)", () => {
  it("devuelve PropuestaVentasSire con las boletas 290 y 292, sin la 291", async () => {
    const p = await ventas(RUC, "202610");
    expect(p.libro).toBe("ventas");
    expect(p.periodo).toBe("202610");
    const claves = p.filas.map(clave);
    expect(claves).toEqual(expect.arrayContaining(["03-B001-290", "03-B001-292"]));
    expect(claves).not.toContain("03-B001-291");
  });

  it("cada fila trae exactamente las columnas de FilaVentaSire y ninguna de compras", async () => {
    const p = await ventas(RUC, "202610");
    expect(p.filas.length).toBeGreaterThan(0);
    for (const fila of p.filas) {
      const claves = Object.keys(fila);
      for (const k of OBLIGATORIAS) expect(claves, `${clave(fila)} sin ${k}`).toContain(k);
      for (const k of claves) {
        expect(
          [...OBLIGATORIAS, ...OPCIONALES] as string[],
          `${clave(fila)} trae la columna ajena ${k}`,
        ).toContain(k);
      }
      for (const k of COLUMNAS_DE_COMPRAS) expect(claves).not.toContain(k);
    }
  });

  it("todos los montos son cadenas con 2 decimales y el tipo de cambio, cuando está, con 3", async () => {
    const p = await ventas(RUC, "202610");
    for (const fila of p.filas) {
      for (const m of MONTOS) {
        expect(typeof fila[m], `${clave(fila)}.${m}`).toBe("string");
        expect(fila[m]).toMatch(/^-?\d+\.\d{2}$/);
      }
      if (fila.tipoCambio !== undefined) expect(fila.tipoCambio).toMatch(/^\d+\.\d{3}$/);
    }
  });

  it("trae los casos del plan: serie completa, NC en negativo, USD con y sin TC, salto de B003, exonerada", async () => {
    const p = await ventas(RUC, "202610");
    const por = new Map(p.filas.map((f) => [clave(f), f]));
    for (const k of ["01-F001-10", "01-F001-11", "01-F001-12"]) expect(por.has(k), k).toBe(true);
    for (const k of ["03-B003-400", "03-B003-401", "03-B003-405"]) expect(por.has(k), k).toBe(true);
    expect(por.has("03-B003-402")).toBe(false);
    const nc = [...por.values()].find((f) => f.tipo === "07");
    expect(nc, "falta la nota de crédito (tipo 07)").toBeDefined();
    expect(nc?.total.startsWith("-")).toBe(true);
    const usd = p.filas.filter((f) => f.moneda === "USD");
    expect(usd.some((f) => f.tipoCambio !== undefined)).toBe(true);
    expect(usd.some((f) => f.tipoCambio === undefined)).toBe(true);
    expect(p.filas.some((f) => f.exonerada !== "0.00")).toBe(true);
  });

  it("el documento de la contraparte es `-` en boletas de consumidor final y un RUC con tipo 6 en facturas", async () => {
    const p = await ventas(RUC, "202610");
    const boleta = p.filas.find((f) => f.serie === "B001" && f.numero === "290");
    expect(boleta?.docContraparte).toBe("-");
    const factura = p.filas.find((f) => f.serie === "F001" && f.numero === "10");
    expect(factura?.tipoDocContraparte).toBe("6");
    expect(factura?.docContraparte).toMatch(/^\d{11}$/);
  });

  it("sin números que terminen en 7, 8 o 9 (centinelas de los mocks)", async () => {
    const p = await ventas(RUC, "202610");
    for (const f of p.filas) expect(f.numero, clave(f)).not.toMatch(/[789]$/);
  });

  it("mutar la respuesta no altera la siguiente", async () => {
    const mock = new MockSireApiClient();
    const a = await ventas(RUC, "202610", mock);
    const n = a.filas.length;
    a.filas.length = 0;
    expect((await ventas(RUC, "202610", mock)).filas).toHaveLength(n);
  });
});

describe("MockSireApiClient ventas: conjunto genérico (CA-1)", () => {
  it("un RUC sin fixture recibe filas de venta con el periodo pedido, deterministas", async () => {
    const mock = new MockSireApiClient();
    const p = await ventas(AJENO, "202611", mock);
    expect(p.periodo).toBe("202611");
    expect(p.filas.length).toBeGreaterThan(0);
    for (const fila of p.filas) {
      expect(fila.fechaEmision).toMatch(/^2026-11-\d{2}$/);
      for (const k of OBLIGATORIAS) expect(Object.keys(fila)).toContain(k);
      for (const k of COLUMNAS_DE_COMPRAS) expect(Object.keys(fila)).not.toContain(k);
    }
    expect(await ventas(AJENO, "202611", mock)).toEqual(p);
  });

  it("trae las boletas 290 y 292 y no la 291", async () => {
    const claves = (await ventas(AJENO, "202611")).filas.map(clave);
    expect(claves).toEqual(expect.arrayContaining(["03-B001-290", "03-B001-292"]));
    expect(claves).not.toContain("03-B001-291");
  });
});

describe("MockSireApiClient ventas: errores (CA-2)", () => {
  const clase = async (mock: MockSireApiClient, ruc = RUC): Promise<string> =>
    clasificarError(
      await mock.descargarPropuesta(TOKEN, pedir(ruc, "202610", "ventas")).catch((e: unknown) => e),
    ).clase;

  it("fallar('timeout') da transitorio y fallar('401') (credencial rechazada) da credencial", async () => {
    // El modo de credencial del mock se llama "401"; CA-2 lo nombra `fallar("credencial")` (misma clase).
    const mock = new MockSireApiClient();
    mock.fallar("timeout");
    expect(await clase(mock)).toBe("transitorio");
    mock.fallar("401");
    expect(await clase(mock)).toBe("credencial");
    mock.fallar("5xx");
    expect(await clase(mock)).toBe("transitorio");
    mock.fallar("datos");
    expect(await clase(mock)).toBe("datos");
  });

  it("con `veces: 1` falla una vez y luego devuelve la propuesta de ventas", async () => {
    const mock = new MockSireApiClient();
    mock.fallar("timeout", { veces: 1 });
    expect(await clase(mock)).toBe("transitorio");
    expect((await ventas(RUC, "202610", mock)).libro).toBe("ventas");
  });

  it("los centinelas 7, 8 y 9 del RUC siguen valiendo en ventas", async () => {
    const mock = new MockSireApiClient();
    expect(await clase(mock, "20100000007")).toBe("transitorio");
    expect(await clase(mock, "20100000008")).toBe("datos");
    expect(await clase(mock, "20100000009")).toBe("credencial");
  });
});

describe("MockSireApiClient compras: no cambia (014)", () => {
  it("devuelve PropuestaComprasSire con las columnas de FilaPropuestaSire y ninguna de ventas", async () => {
    const p: PropuestaSire = await new MockSireApiClient().descargarPropuesta(
      TOKEN,
      pedir(RUC, "202610", "compras"),
    );
    if (p.libro !== "compras") throw new Error("se esperaba la propuesta de compras");
    const filas: FilaPropuestaSire[] = p.filas;
    expect(filas).toHaveLength(5);
    for (const fila of filas) {
      const claves = Object.keys(fila);
      for (const k of ["rucContraparte", "biDg", "igvDg", "biDgng", "igvDgng", "biDng", "igvDng", "noGravado", "total"]) {
        expect(claves, `${fila.serie}-${fila.numero} sin ${k}`).toContain(k);
      }
      for (const k of ["baseGravada", "exonerada", "inafecta", "docContraparte", "tipoDocContraparte"]) {
        expect(claves).not.toContain(k);
      }
    }
  });
});

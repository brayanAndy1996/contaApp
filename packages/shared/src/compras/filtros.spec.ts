import { describe, expect, it } from "vitest";
import { VISTAS_COMPRAS, listarComprasSchema } from "./index.js";

// Spec 014 · T2 (rojo). Filtros del listado de compras (D-13; GET /clientes/:clienteId/periodos/:periodo/compras).
// Contrato fijado por estas pruebas (plan 014, Contratos: HTTP; packages/shared/src/compras/filtros.ts,
// exportado por compras/index.ts). El esquema recibe la QUERY STRING, así que todo llega como texto y se
// convierte:
//  - VISTAS_COMPRAS = ["con_igv", "sin_igv", "excluidas"]; `vista` opcional, una de ellas.
//  - `limite` opcional: entero >= 1 y <= 5000 (RNF-031); acepta "50" o 50 y lo devuelve como number.
//  - `cursor` opcional: cadena opaca no vacía de hasta 1024 caracteres. El esquema no la interpreta (decodificar
//    y rechazar un cursor mal formado es del servicio).
//  - `alertas` y `proveedorNuevo` opcionales: booleanos; aceptan true/false y "true"/"false" (NUNCA
//    «coerce»: "false" no puede dar true). Cualquier otro texto se rechaza.
//  - `q` opcional: texto de hasta 100 caracteres (prefijo de RUC, fragmento de razón social o serie-número).
//    El esquema lo devuelve tal cual: los comodines (% _ \) los escapa el repositorio, no el esquema.
//  - Las claves desconocidas se descartan (z.object).
interface Esquema {
  safeParse: (v: unknown) => { success: boolean; data?: unknown };
}
const ok = (v: unknown) => listarComprasSchema.safeParse(v).success;
const datos = (v: unknown) => {
  const r = (listarComprasSchema as Esquema).safeParse(v);
  expect(r.success).toBe(true);
  return r.data as Record<string, unknown>;
};

describe("VISTAS_COMPRAS", () => {
  it("son tres", () => {
    expect([...VISTAS_COMPRAS]).toEqual(["con_igv", "sin_igv", "excluidas"]);
  });
});

describe("listarComprasSchema", () => {
  it("la query vacía es válida", () => {
    expect(ok({})).toBe(true);
  });

  describe("vista", () => {
    it.each(["con_igv", "sin_igv", "excluidas"])("acepta %j", (vista) => {
      expect(datos({ vista }).vista).toBe(vista);
    });
    it.each(["xyz", "CON_IGV", "con igv", "", null, 1, ["con_igv"]])("rechaza %j", (vista) => {
      expect(ok({ vista })).toBe(false);
    });
  });

  describe("limite", () => {
    it.each([
      ["50", 50],
      [50, 50],
      ["1", 1],
      [1, 1],
      ["100", 100],
      ["5000", 5000],
      [5000, 5000],
    ])("%j → %j", (entrada, esperado) => {
      expect(datos({ limite: entrada }).limite).toBe(esperado);
    });
    it.each([0, "0", -1, "-5", 1.5, "1.5", "abc", "", " ", "5001", 5001, 100000, NaN, Infinity, null, [], {}])("rechaza %j", (limite) => {
      expect(ok({ limite })).toBe(false);
    });
  });

  describe("cursor opaco", () => {
    it("acepta una cadena y la devuelve igual", () => {
      expect(datos({ cursor: "eyJmIjoiMjAyNi0xMC0wMiJ9" }).cursor).toBe("eyJmIjoiMjAyNi0xMC0wMiJ9");
    });
    it("no la interpreta: cualquier texto razonable pasa", () => {
      expect(ok({ cursor: "no-es-base64 !!" })).toBe(true);
    });
    it("hasta 1024 caracteres", () => {
      expect(ok({ cursor: "a".repeat(1024) })).toBe(true);
      expect(ok({ cursor: "a".repeat(1025) })).toBe(false);
    });
    it.each(["", 5, null, [], {}])("rechaza %j", (cursor) => {
      expect(ok({ cursor })).toBe(false);
    });
  });

  describe.each(["alertas", "proveedorNuevo"])("%s", (campo) => {
    it.each([
      [true, true],
      [false, false],
      ["true", true],
      ["false", false],
    ])("%j → %j (sin coerce)", (entrada, esperado) => {
      expect(datos({ [campo]: entrada })[campo]).toBe(esperado);
    });
    it.each(["maybe", "yes", "1", "0", "", "TRUE", 1, 0, null, []])("rechaza %j", (v) => {
      expect(ok({ [campo]: v })).toBe(false);
    });
  });

  describe("q", () => {
    it.each(["20100", "F001-12", "PROVEEDOR", "san juan", "ñandú"])("acepta %j tal cual", (q) => {
      expect(datos({ q }).q).toBe(q);
    });
    it("no escapa los comodines: eso es del repositorio", () => {
      expect(datos({ q: "100%_\\" }).q).toBe("100%_\\");
    });
    it("hasta 100 caracteres", () => {
      expect(ok({ q: "a".repeat(100) })).toBe(true);
      expect(ok({ q: "a".repeat(1000) })).toBe(false);
    });
    it.each([5, null, [], {}, true])("rechaza %j", (q) => {
      expect(ok({ q })).toBe(false);
    });
  });

  it("todos los filtros juntos", () => {
    const d = datos({ cursor: "abc", limite: "100", vista: "con_igv", alertas: "true", proveedorNuevo: "false", q: "F001" });
    expect(d).toEqual({ cursor: "abc", limite: 100, vista: "con_igv", alertas: true, proveedorNuevo: false, q: "F001" });
  });

  it("descarta claves desconocidas (tenantId, clienteId, periodo)", () => {
    const d = datos({ limite: "10", tenantId: "x", clienteId: "y", periodo: "202610" });
    expect(Object.keys(d)).toEqual(["limite"]);
  });
});

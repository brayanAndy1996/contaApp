import { describe, expect, it } from "vitest";
import { filtrosVentasSchema } from "./esquemas.js";

// Spec 013 (D10; CA-5; plan: Contratos shared y Rutas). Contrato fijado por estas pruebas, en el patrón
// <entidad><Accion>Schema de 007a:
//  - filtrosVentasSchema: query string de `GET …/ventas`. Todo opcional:
//    pagina (entero >= 1, llega como texto), tamano ('10'|'25'|'50'|'todas' -> 10|25|50|'todas'),
//    q (<= 100), tipo (2 dígitos), serie (1 a 4 caracteres alfanuméricos), min y max (cadenas decimales de
//    NUMERIC(14,2); admiten hasta 3 decimales para comparar 0.005 sin `number`).
//  - Claves desconocidas descartadas. Ningún monto llega a ser `number`.
interface Esquema {
  safeParse: (v: unknown) => { success: boolean; data?: unknown };
}
const ok = (s: Esquema, v: unknown) => s.safeParse(v).success;
const datos = (v: unknown) => {
  const r = filtrosVentasSchema.safeParse(v);
  expect(r.success).toBe(true);
  return r.data as Record<string, unknown>;
};

describe("filtrosVentasSchema: forma general", () => {
  it("acepta la consulta vacía (todo es opcional)", () => {
    expect(ok(filtrosVentasSchema, {})).toBe(true);
  });

  it("acepta todos los filtros juntos y devuelve los montos como cadenas", () => {
    const d = datos({
      pagina: "2",
      tamano: "50",
      q: "B001",
      tipo: "03",
      serie: "B001",
      min: "0.005",
      max: "999999999999.99",
    });
    expect(d).toMatchObject({
      pagina: 2,
      tamano: 50,
      q: "B001",
      tipo: "03",
      serie: "B001",
      min: "0.005",
      max: "999999999999.99",
    });
    expect(typeof d.min).toBe("string");
    expect(typeof d.max).toBe("string");
  });

  it("descarta las claves desconocidas (tenantId, clienteId, orden...)", () => {
    const d = datos({ tipo: "01", tenantId: "x", clienteId: "y", orden: "total", origen: "manual" });
    expect(d).not.toHaveProperty("tenantId");
    expect(d).not.toHaveProperty("clienteId");
    expect(d).not.toHaveProperty("orden");
    expect(d).not.toHaveProperty("origen");
    expect(d.tipo).toBe("01");
  });
});

describe("filtrosVentasSchema: pagina y tamano (10/25/50/todas)", () => {
  it.each([
    ["10", 10],
    ["25", 25],
    ["50", 50],
    ["todas", "todas"],
  ])("tamano %j -> %j", (entrada, esperado) => {
    expect(datos({ tamano: entrada }).tamano).toBe(esperado);
  });

  it.each(["0", "5", "11", "100", "1000", "-10", "10.5", "TODAS", "Todas", "todos", "all", "", " 10", "10 "])(
    "rechaza el tamano %j",
    (tamano) => {
      expect(ok(filtrosVentasSchema, { tamano })).toBe(false);
    },
  );

  it.each([null, {}, [], true])("rechaza un tamano que no es texto ni número (%j)", (tamano) => {
    expect(ok(filtrosVentasSchema, { tamano })).toBe(false);
  });

  it.each([
    ["1", 1],
    ["2", 2],
    ["400", 400],
  ])("pagina %j -> %j", (entrada, esperado) => {
    expect(datos({ pagina: entrada }).pagina).toBe(esperado);
  });

  it.each(["0", "-1", "1.5", "abc", "", " 1", "1e2", "NaN", "Infinity", "01 "])(
    "rechaza la pagina %j",
    (pagina) => {
      expect(ok(filtrosVentasSchema, { pagina })).toBe(false);
    },
  );
});

describe("filtrosVentasSchema: q acotada", () => {
  it("acepta de 1 a 100 caracteres", () => {
    expect(ok(filtrosVentasSchema, { q: "a" })).toBe(true);
    expect(ok(filtrosVentasSchema, { q: "a".repeat(100) })).toBe(true);
  });

  it("rechaza más de 100 caracteres", () => {
    expect(ok(filtrosVentasSchema, { q: "a".repeat(101) })).toBe(false);
    expect(ok(filtrosVentasSchema, { q: "a".repeat(5000) })).toBe(false);
  });

  it.each([123, null, {}, ["a"], true])("rechaza una q que no es texto (%j)", (q) => {
    expect(ok(filtrosVentasSchema, { q })).toBe(false);
  });

  it("deja pasar `%`, `_` y comillas como texto (el servidor las escapa; el esquema no las altera)", () => {
    for (const q of ["100%", "B_01", "o'brien", 'a"b', "x';--"]) {
      expect(datos({ q }).q).toBe(q);
    }
  });
});

describe("filtrosVentasSchema: tipo y serie", () => {
  it.each(["01", "03", "07", "08"])("acepta el tipo %s", (tipo) => {
    expect(ok(filtrosVentasSchema, { tipo })).toBe(true);
  });

  it.each(["1", "001", "", "0%", "a1", "0 ", "'1", "1_"])("rechaza el tipo %j", (tipo) => {
    expect(ok(filtrosVentasSchema, { tipo })).toBe(false);
  });

  it.each(["B001", "F001", "E001", "1", "BC1"])("acepta la serie %s", (serie) => {
    expect(ok(filtrosVentasSchema, { serie })).toBe(true);
  });

  it.each(["B0001", "", "B%01", "B_01", "B'01", "B 01", "B-01", "B01\n"])(
    "rechaza la serie %j",
    (serie) => {
      expect(ok(filtrosVentasSchema, { serie })).toBe(false);
    },
  );
});

describe("filtrosVentasSchema: rango de montos como cadenas decimales (CA-5)", () => {
  it.each(["min", "max"])("%s acepta los extremos de NUMERIC(14,2) y 0.005", (campo) => {
    for (const v of ["0", "0.00", "0.005", "0.01", "100", "100.5", "100.50", "999999999999.99", "-59.00", "-999999999999.99"]) {
      expect(datos({ [campo]: v })[campo], v).toBe(v);
    }
  });

  it.each(["min", "max"])("%s rechaza lo que no es un decimal canónico o excede NUMERIC(14,2)", (campo) => {
    for (const v of [
      "",
      " ",
      "abc",
      "1e3",
      "1,5",
      "1.",
      ".5",
      "+5",
      "007",
      "5 ",
      " 5",
      "1.0005",
      "NaN",
      "Infinity",
      "0x10",
      "1000000000000.00",
      "99999999999999",
      "5; DROP TABLE venta",
      "5'",
      "5%",
    ]) {
      expect(ok(filtrosVentasSchema, { [campo]: v }), `${campo}=${JSON.stringify(v)}`).toBe(false);
    }
  });

  it.each(["min", "max"])("%s rechaza un `number` (los montos viajan como cadenas)", (campo) => {
    for (const v of [5, 0.005, 999999999999.99, NaN, null, {}, []]) {
      expect(ok(filtrosVentasSchema, { [campo]: v }), `${campo}=${String(v)}`).toBe(false);
    }
  });
});

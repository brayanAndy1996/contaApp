import { describe, expect, it } from "vitest";
import { ventaAgregarSchema } from "./esquemas.js";

// Spec 013 (D9; CA-8; plan: Contratos shared y Rutas, `POST /` agregar). Contrato fijado por estas pruebas:
//  - ventaAgregarSchema: cuerpo de agregar una venta a mano. Mismos nombres que `FilaVentaSire`:
//    tipo (2 dígitos), serie (4 caracteres alfanuméricos), numero (cadena de dígitos, 1 a 20), fechaEmision
//    (AAAA-MM-DD real), moneda (PEN|USD), tipoCambio (solo con USD; hasta 3 decimales, > 0), tipoDocContraparte
//    (opcional), docContraparte (`-` para consumidor final) y los 8 montos (baseGravada, igv, exonerada,
//    inafecta, isc, icbper, otros, total) como cadenas decimales canónicas de NUMERIC(14,2) (la gramática
//    de `Money`: signo opcional, sin ceros a la izquierda, hasta 2 decimales).
//  - Claves desconocidas descartadas: el origen, el cliente, el estudio y la propuesta no viajan por el cuerpo.
//  - El esquema NO verifica el cuadre del total ni que la clave no esté repetida: eso lo hace el servicio
//    (verificarCuadre -> 400 y duplicado -> 409), cubierto en las pruebas de integración.
const base = {
  tipo: "03",
  serie: "B001",
  numero: "291",
  fechaEmision: "2026-10-04",
  moneda: "PEN",
  docContraparte: "-",
  baseGravada: "100.00",
  igv: "18.00",
  exonerada: "0.00",
  inafecta: "0.00",
  isc: "0.00",
  icbper: "0.00",
  otros: "0.00",
  total: "118.00",
};
const MONTOS = ["baseGravada", "igv", "exonerada", "inafecta", "isc", "icbper", "otros", "total"] as const;
const ok = (v: unknown) => ventaAgregarSchema.safeParse(v).success;
const con = (cambios: Record<string, unknown>) => ({ ...base, ...cambios });
const sin = (campo: string) => {
  const resto: Record<string, unknown> = { ...base };
  delete resto[campo];
  return resto;
};

describe("ventaAgregarSchema: cuerpo válido", () => {
  it("acepta la boleta B001-291 y la devuelve igual (cadenas, sin convertir)", () => {
    const r = ventaAgregarSchema.safeParse(base);
    expect(r.success).toBe(true);
    expect(r.data).toEqual(base);
    for (const m of MONTOS) expect(typeof (r.data as Record<string, unknown>)[m]).toBe("string");
  });

  it("acepta una factura con RUC de contraparte (tipoDocContraparte '6')", () => {
    expect(
      ok(con({ tipo: "01", serie: "F001", numero: "13", tipoDocContraparte: "6", docContraparte: "20700000011" })),
    ).toBe(true);
  });

  it("acepta una nota de crédito con montos negativos", () => {
    expect(
      ok(
        con({
          tipo: "07",
          serie: "F001",
          numero: "2",
          baseGravada: "-50.00",
          igv: "-9.00",
          total: "-59.00",
        }),
      ),
    ).toBe(true);
  });

  it("acepta USD con tipo de cambio de 3 decimales", () => {
    expect(ok(con({ moneda: "USD", tipoCambio: "3.300" }))).toBe(true);
    expect(ok(con({ moneda: "USD", tipoCambio: "3.3" }))).toBe(true);
  });

  it("descarta las claves desconocidas (origen, clienteId, tenantId, propuestaId, id, creadaPor)", () => {
    const r = ventaAgregarSchema.safeParse(
      con({
        origen: "sire",
        clienteId: "x",
        tenantId: "y",
        propuestaId: "z",
        id: "w",
        creadaPor: "u",
        periodo: "199901",
        clave: "03-B001-999",
      }),
    );
    expect(r.success).toBe(true);
    expect(r.data).toEqual(base);
  });
});

describe("ventaAgregarSchema: tipo, serie y número", () => {
  it.each(["01", "03", "07", "08"])("acepta el tipo %s", (tipo) => {
    expect(ok(con({ tipo }))).toBe(true);
  });
  it.each(["", "3", "003", "0a", "A1", " 03", "03 ", "0%", 3])("rechaza el tipo %j", (tipo) => {
    expect(ok(con({ tipo }))).toBe(false);
  });

  it.each(["B001", "F001", "E001", "0001"])("acepta la serie %s", (serie) => {
    expect(ok(con({ serie }))).toBe(true);
  });
  it.each(["", "B01", "B0001", "B-01", "B 01", "B%01", "B_01", "B'01", " B001", "B001 ", 1])(
    "rechaza la serie %j",
    (serie) => {
      expect(ok(con({ serie }))).toBe(false);
    },
  );

  it.each(["1", "291", "00000291", "99999999"])("acepta el número %s", (numero) => {
    expect(ok(con({ numero }))).toBe(true);
  });
  it.each(["", " ", "12 3", "1'2", "1%", "-1", "1.5", "1e3", "2".repeat(21), "291\n", "=1+1"])(
    "rechaza el número %j",
    (numero) => {
      expect(ok(con({ numero }))).toBe(false);
    },
  );

  it.each(["tipo", "serie", "numero"])("exige %s", (campo) => {
    expect(ok(sin(campo))).toBe(false);
  });
});

describe("ventaAgregarSchema: fecha", () => {
  it.each(["2026-10-04", "2026-02-28", "2028-02-29", "2026-10-31"])("acepta %s", (fechaEmision) => {
    expect(ok(con({ fechaEmision }))).toBe(true);
  });

  it.each([
    ["día 30 de febrero", "2026-02-30"],
    ["29 de febrero sin bisiesto", "2026-02-29"],
    ["mes 13", "2026-13-01"],
    ["mes 00", "2026-00-10"],
    ["día 00", "2026-10-00"],
    ["día 32", "2026-10-32"],
    ["31 de abril", "2026-04-31"],
    ["formato dd/mm/aaaa", "04/10/2026"],
    ["día de un dígito", "2026-10-4"],
    ["con hora", "2026-10-04T00:00:00Z"],
    ["sin guiones", "20261004"],
    ["vacía", ""],
    ["con espacio", " 2026-10-04"],
    ["texto", "ayer"],
    ["número", 20261004],
    ["null", null],
  ])("rechaza la fecha %s", (_c, fechaEmision) => {
    expect(ok(con({ fechaEmision }))).toBe(false);
  });

  it("exige la fecha", () => {
    expect(ok(sin("fechaEmision"))).toBe(false);
  });
});

describe("ventaAgregarSchema: moneda y tipo de cambio (solo en USD)", () => {
  it.each(["PEN", "USD"])("acepta la moneda %s", (moneda) => {
    expect(ok(con({ moneda }))).toBe(true);
  });
  it.each(["EUR", "pen", "usd", "", "S/", null, 1])("rechaza la moneda %j", (moneda) => {
    expect(ok(con({ moneda }))).toBe(false);
  });
  it("exige la moneda", () => {
    expect(ok(sin("moneda"))).toBe(false);
  });

  it("rechaza un tipo de cambio con PEN", () => {
    expect(ok(con({ moneda: "PEN", tipoCambio: "3.300" }))).toBe(false);
    expect(ok(con({ moneda: "PEN", tipoCambio: "1" }))).toBe(false);
  });

  it.each(["3.3", "3.30", "3.300", "3.333", "0.001", "1", "3.75"])(
    "acepta el tipo de cambio %s con USD",
    (tipoCambio) => {
      expect(ok(con({ moneda: "USD", tipoCambio }))).toBe(true);
    },
  );

  it.each(["0", "0.000", "-3.3", "3.3333", "3.3000", "", "abc", "3,3", "3.3e0", "+3.3", " 3.3", "10000", 3.3, null])(
    "rechaza el tipo de cambio %j con USD",
    (tipoCambio) => {
      expect(ok(con({ moneda: "USD", tipoCambio }))).toBe(false);
    },
  );
});

describe("ventaAgregarSchema: montos como cadenas decimales", () => {
  it.each(MONTOS)("%s acepta cadenas decimales canónicas", (campo) => {
    for (const v of ["0", "0.00", "100.00", "100", "100.5", "-59.00", "999999999999.99"]) {
      expect(ok(con({ [campo]: v })), `${campo}=${v}`).toBe(true);
    }
  });

  it.each(MONTOS)("%s rechaza un `number`", (campo) => {
    for (const v of [0, 100, 100.5, 118, NaN, Infinity]) {
      expect(ok(con({ [campo]: v })), `${campo}=${String(v)}`).toBe(false);
    }
  });

  it.each(MONTOS)("%s rechaza lo que no es decimal canónico o excede NUMERIC(14,2)", (campo) => {
    for (const v of [
      "",
      " ",
      "abc",
      "1e2",
      "1,000.00",
      "100,5",
      "100.001",
      "100.",
      ".5",
      "+5",
      "007",
      " 5",
      "5 ",
      "NaN",
      "Infinity",
      "1000000000000.00",
      "-1000000000000.00",
      "99999999999999999999",
      null,
      undefined,
      {},
      [],
      true,
    ]) {
      expect(ok(con({ [campo]: v })), `${campo}=${JSON.stringify(v) ?? "undefined"}`).toBe(false);
    }
  });

  it("exige el total", () => {
    expect(ok(sin("total"))).toBe(false);
  });
});

describe("ventaAgregarSchema: documento de la contraparte", () => {
  it("acepta `-` (consumidor final) y un RUC", () => {
    expect(ok(con({ docContraparte: "-" }))).toBe(true);
    expect(ok(con({ tipoDocContraparte: "6", docContraparte: "20700000011" }))).toBe(true);
  });

  it("rechaza un documento vacío, larguísimo o que no es texto", () => {
    for (const docContraparte of ["", "x".repeat(21), 20700000011, null]) {
      expect(ok(con({ docContraparte })), JSON.stringify(docContraparte)).toBe(false);
    }
  });

  it("rechaza un tipo de documento vacío o que no es texto", () => {
    for (const tipoDocContraparte of ["", 6, null]) {
      expect(ok(con({ tipoDocContraparte })), JSON.stringify(tipoDocContraparte)).toBe(false);
    }
  });
});

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  destinoDesdeXmlSchema,
  vistaPreviaDesdeXmlSchema,
} from "./desde-xml.js";
import { errorXmlSchema } from "./errores.js";

// Spec 016 · T4. Agregar desde XML (plan 016, Contratos: HTTP; P-9) y códigos de error de las rutas con XML.
/** Copia del objeto sin la clave `campo`. */
const sin = (
  o: Record<string, unknown>,
  campo: string,
): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([k]) => k !== campo));
const ok = (
  esquema: { safeParse: (v: unknown) => { success: boolean } },
  valor: unknown,
) => esquema.safeParse(valor).success;

const item = {
  descripcion: "Cerveza 620 ml",
  cantidad: "12",
  unidad: "NIU",
  precioUnitario: "3.4567",
  valor: "41.48",
  afectacion: "10",
  igv: "7.47",
  isc: "0.00",
  icbper: "0.00",
};
const vista = (o: Record<string, unknown> = {}) => ({
  tipo: "01",
  serie: "F001",
  numero: "2056",
  proveedor: { tipo: "6", numero: "20100070970", razonSocial: "PROVEEDOR SAC" },
  fecha: "2026-10-12",
  moneda: "PEN",
  montos: { biDg: "100.00", igvDg: "18.00", noGravado: "5.00" },
  items: [item],
  existente: null,
  requiereTipoCambio: false,
  ...o,
});

describe("destinoDesdeXmlSchema (query de POST /desde-xml)", () => {
  it.each(["DG", "DGNG", "DNG"])("acepta el destino %s", (destino) => {
    expect(destinoDesdeXmlSchema.parse({ destino })).toMatchObject({ destino });
  });

  it("el destino es obligatorio y solo admite DG, DGNG o DNG", () => {
    expect(ok(destinoDesdeXmlSchema, {})).toBe(false);
    expect(ok(destinoDesdeXmlSchema, { destino: "dg" })).toBe(false);
    expect(ok(destinoDesdeXmlSchema, { destino: "XX" })).toBe(false);
    expect(ok(destinoDesdeXmlSchema, { destino: "" })).toBe(false);
  });

  it("acepta un tipo de cambio con la gramática de 014 (hasta 3 decimales)", () => {
    expect(
      destinoDesdeXmlSchema.parse({ destino: "DG", tipoCambio: "3.752" }),
    ).toEqual({ destino: "DG", tipoCambio: "3.752" });
  });

  it.each(["3.7521", "-3.7", "3,75", "abc", "1e2", "12345.1", ""])(
    "rechaza el tipo de cambio %j",
    (tipoCambio) => {
      expect(ok(destinoDesdeXmlSchema, { destino: "DG", tipoCambio })).toBe(
        false,
      );
    },
  );

  it("el tipo de cambio es opcional (el esquema no conoce la moneda; el servicio aplica agregarCompraSchema)", () => {
    expect(ok(destinoDesdeXmlSchema, { destino: "DNG" })).toBe(true);
  });

  it("descarta claves ajenas: un tenantId o clienteId de la query nunca viaja", () => {
    const r = destinoDesdeXmlSchema.parse({
      destino: "DG",
      tenantId: randomUUID(),
      clienteId: randomUUID(),
    }) as Record<string, unknown>;
    expect(r).toEqual({ destino: "DG" });
  });
});

describe("vistaPreviaDesdeXmlSchema", () => {
  it("acepta una vista previa en PEN sin tipo de cambio y sin existente", () => {
    expect(ok(vistaPreviaDesdeXmlSchema, vista())).toBe(true);
  });

  it("USD no trae tipo de cambio (P-9): requiereTipoCambio = true", () => {
    expect(
      ok(
        vistaPreviaDesdeXmlSchema,
        vista({ moneda: "USD", requiereTipoCambio: true }),
      ),
    ).toBe(true);
  });

  it("requiereTipoCambio es coherente con la moneda del XML", () => {
    expect(
      ok(
        vistaPreviaDesdeXmlSchema,
        vista({ moneda: "USD", requiereTipoCambio: false }),
      ),
    ).toBe(false);
    expect(
      ok(
        vistaPreviaDesdeXmlSchema,
        vista({ moneda: "PEN", requiereTipoCambio: true }),
      ),
    ).toBe(false);
  });

  it("no devuelve tipo de cambio ni destino: lo pone el usuario", () => {
    const r = vistaPreviaDesdeXmlSchema.parse(
      vista({ tipoCambio: "3.752", destino: "DG" }),
    ) as Record<string, unknown>;
    expect(r).not.toHaveProperty("tipoCambio");
    expect(r).not.toHaveProperty("destino");
  });

  it("existente es {id} o null (CA-13: duplicado)", () => {
    expect(
      ok(vistaPreviaDesdeXmlSchema, vista({ existente: { id: randomUUID() } })),
    ).toBe(true);
    expect(
      ok(vistaPreviaDesdeXmlSchema, vista({ existente: { id: "no-uuid" } })),
    ).toBe(false);
    expect(ok(vistaPreviaDesdeXmlSchema, vista({ existente: undefined }))).toBe(
      false,
    );
  });

  it("los montos son cadenas decimales de a lo sumo 2 decimales; number se rechaza", () => {
    expect(
      ok(vistaPreviaDesdeXmlSchema, vista({ montos: { biDg: 100 } })),
    ).toBe(false);
    expect(
      ok(vistaPreviaDesdeXmlSchema, vista({ montos: { biDg: "100.001" } })),
    ).toBe(false);
  });

  it("usa las mismas columnas de monto que agregarCompraSchema: el total no viaja", () => {
    const r = vistaPreviaDesdeXmlSchema.parse(
      vista({ montos: { biDg: "100.00", total: "118.00" } }),
    ) as { montos: Record<string, unknown> };
    expect(r.montos).not.toHaveProperty("total");
  });

  it("la identidad y el proveedor siguen las gramáticas de 014", () => {
    expect(ok(vistaPreviaDesdeXmlSchema, vista({ tipo: "1" }))).toBe(false);
    expect(ok(vistaPreviaDesdeXmlSchema, vista({ serie: "f001" }))).toBe(false);
    expect(ok(vistaPreviaDesdeXmlSchema, vista({ numero: "123456789" }))).toBe(
      false,
    );
    expect(ok(vistaPreviaDesdeXmlSchema, vista({ fecha: "12/10/2026" }))).toBe(
      false,
    );
    expect(ok(vistaPreviaDesdeXmlSchema, vista({ moneda: "EUR" }))).toBe(false);
    expect(
      ok(
        vistaPreviaDesdeXmlSchema,
        vista({
          proveedor: { tipo: "6", numero: "20100070970", razonSocial: "" },
        }),
      ),
    ).toBe(false);
  });

  it("la razón social es texto de una línea sin caracteres de control", () => {
    expect(
      ok(
        vistaPreviaDesdeXmlSchema,
        vista({
          proveedor: {
            tipo: "6",
            numero: "20100070970",
            razonSocial: "A\u0000B",
          },
        }),
      ),
    ).toBe(false);
    expect(
      ok(
        vistaPreviaDesdeXmlSchema,
        vista({
          proveedor: {
            tipo: "6",
            numero: "20100070970",
            razonSocial: "<b>X</b> SAC",
          },
        }),
      ),
    ).toBe(true);
  });

  it("los ítems siguen el esquema del detalle (2.000 como tope, glosa ≤ 500)", () => {
    expect(
      ok(
        vistaPreviaDesdeXmlSchema,
        vista({ items: Array.from({ length: 2000 }, () => item) }),
      ),
    ).toBe(true);
    expect(
      ok(
        vistaPreviaDesdeXmlSchema,
        vista({ items: Array.from({ length: 2001 }, () => item) }),
      ),
    ).toBe(false);
    expect(
      ok(
        vistaPreviaDesdeXmlSchema,
        vista({ items: [{ ...item, descripcion: "a".repeat(501) }] }),
      ),
    ).toBe(false);
  });

  it("exige los campos de identidad, proveedor, fecha, moneda, montos, ítems, existente y requiereTipoCambio", () => {
    for (const campo of [
      "tipo",
      "serie",
      "numero",
      "proveedor",
      "fecha",
      "moneda",
      "montos",
      "items",
      "requiereTipoCambio",
    ]) {
      expect(ok(vistaPreviaDesdeXmlSchema, sin(vista(), campo))).toBe(false);
    }
  });
});

describe("errorXmlSchema (códigos de las rutas con XML)", () => {
  it.each(["xml_invalido", "xml_incompleto", "xml_existente"])(
    "acepta {codigo: %s}",
    (codigo) => {
      expect(errorXmlSchema.parse({ codigo })).toEqual({ codigo });
    },
  );

  it("xml_ajeno lleva los campos que difieren y nada más del XML", () => {
    const r = errorXmlSchema.parse({
      codigo: "xml_ajeno",
      campos: ["ruc", "serie"],
      contenido: "<xml/>",
      mensaje: "x",
    });
    expect(r).toEqual({ codigo: "xml_ajeno", campos: ["ruc", "serie"] });
  });

  it.each(["ruc", "tipo", "serie", "numero", "receptor"])(
    "xml_ajeno admite el campo %s",
    (campo) => {
      expect(ok(errorXmlSchema, { codigo: "xml_ajeno", campos: [campo] })).toBe(
        true,
      );
    },
  );

  it("xml_ajeno exige al menos un campo, de los conocidos, sin repetir", () => {
    expect(ok(errorXmlSchema, { codigo: "xml_ajeno" })).toBe(false);
    expect(ok(errorXmlSchema, { codigo: "xml_ajeno", campos: [] })).toBe(false);
    expect(
      ok(errorXmlSchema, { codigo: "xml_ajeno", campos: ["razonSocial"] }),
    ).toBe(false);
    expect(
      ok(errorXmlSchema, { codigo: "xml_ajeno", campos: ["ruc", "ruc"] }),
    ).toBe(false);
  });

  it("rechaza un código desconocido, ausente o de otra spec", () => {
    expect(ok(errorXmlSchema, { codigo: "xml_roto" })).toBe(false);
    expect(ok(errorXmlSchema, { codigo: "duplicado" })).toBe(false);
    expect(ok(errorXmlSchema, {})).toBe(false);
    expect(ok(errorXmlSchema, "xml_invalido")).toBe(false);
  });

  it("los códigos sin campos no los admiten (se descartan)", () => {
    expect(
      errorXmlSchema.parse({ codigo: "xml_invalido", campos: ["ruc"] }),
    ).toEqual({ codigo: "xml_invalido" });
  });
});

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { origenDocumentoXmlSchema } from "./origen-documento.js";
import { detalleLupaSchema, itemXmlSchema } from "./detalle.js";

// Spec 016 · T4. Formas de `DetalleCompraDto` (plan 016, Contratos: HTTP). Nota: el `detalleCompraSchema` de 014
// (GET /:compraId) ya existe en `compras/respuestas.ts`; el de 016 se llama `detalleLupaSchema` para no chocar.
// Los montos viajan como cadenas decimales: ningún esquema acepta un `number` para dinero.
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

describe("origenDocumentoXmlSchema", () => {
  it.each(["simulado", "real", "subido"])("acepta %s", (valor) => {
    expect(origenDocumentoXmlSchema.parse(valor)).toBe(valor);
  });

  it.each(["Subido", "fixture", "", null, 1, undefined])(
    "rechaza %s",
    (valor) => {
      expect(ok(origenDocumentoXmlSchema, valor)).toBe(false);
    },
  );
});

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
const hallazgo = {
  regla: "R-MIX",
  destino: null,
  explicacion: "Mezcla gravado y exonerado",
  sugerencia: null,
  requiereConfirmacion: false,
  dato: null,
  masiva: true,
};
const cabecera = {
  ruc: "20100070970",
  razonSocial: "PROVEEDOR SAC",
  proveedorNuevo: false,
  tipo: "01",
  serie: "F001",
  numero: "2056",
  fecha: "2026-10-12",
  moneda: "PEN",
  tipoCambio: null,
  origenSerie: "F",
};
const comparacionFila = {
  columna: "igv",
  sire: "1.61",
  xml: "1.61",
  difiere: false,
};
const historial = {
  periodo: "202609",
  serie: "F001",
  numero: "1500",
  biDg: "100.00",
  biDgng: "0.00",
  biDng: "0.00",
  excluida: false,
};
const detalle = (o: Record<string, unknown> = {}) => ({
  cabecera,
  items: [item],
  comparacion: [comparacionFila],
  hallazgos: [hallazgo],
  historialProveedor: [historial],
  xml: { estado: "sin_solicitar" },
  ...o,
});

describe("itemXmlSchema", () => {
  it("acepta un ítem con montos y precio unitario como texto exacto", () => {
    expect(itemXmlSchema.parse(item)).toEqual(item);
  });

  it.each(["valor", "igv", "isc", "icbper", "cantidad", "precioUnitario"])(
    "rechaza %s como number",
    (campo) => {
      expect(ok(itemXmlSchema, { ...item, [campo]: 12.5 })).toBe(false);
    },
  );

  it.each(["1e3", "12,50", "abc", "", "1.", " 1"])(
    "rechaza el monto %j",
    (valor) => {
      expect(ok(itemXmlSchema, { ...item, valor })).toBe(false);
    },
  );

  it("el valor y los impuestos tienen a lo sumo 2 decimales (NUMERIC(14,2))", () => {
    expect(ok(itemXmlSchema, { ...item, valor: "41.481" })).toBe(false);
    expect(ok(itemXmlSchema, { ...item, igv: "7.471" })).toBe(false);
  });

  it("la glosa admite 500 caracteres y rechaza 501", () => {
    expect(ok(itemXmlSchema, { ...item, descripcion: "a".repeat(500) })).toBe(
      true,
    );
    expect(ok(itemXmlSchema, { ...item, descripcion: "a".repeat(501) })).toBe(
      false,
    );
  });

  it("la glosa con <script> es texto: el esquema no la altera", () => {
    const glosa = "<script>alert(1)</script>";
    expect(itemXmlSchema.parse({ ...item, descripcion: glosa })).toMatchObject({
      descripcion: glosa,
    });
  });

  it("exige todos los campos", () => {
    for (const campo of Object.keys(item)) {
      expect(ok(itemXmlSchema, sin(item, campo))).toBe(false);
    }
  });
});

describe("detalleLupaSchema · forma general", () => {
  it("acepta un detalle completo", () => {
    expect(ok(detalleLupaSchema, detalle())).toBe(true);
  });

  it("descarta claves desconocidas (tenantId, rutas de storage)", () => {
    const r = detalleLupaSchema.parse(
      detalle({ tenantId: randomUUID(), ruta: "xml/t/c/u.xml" }),
    ) as Record<string, unknown>;
    expect(r).not.toHaveProperty("tenantId");
    expect(r).not.toHaveProperty("ruta");
  });

  it.each([
    "cabecera",
    "items",
    "comparacion",
    "hallazgos",
    "historialProveedor",
    "xml",
  ])("exige %s", (campo) => {
    expect(ok(detalleLupaSchema, sin(detalle(), campo))).toBe(false);
  });

  it("la cabecera exige moneda PEN o USD y origenSerie E, F o null", () => {
    expect(
      ok(
        detalleLupaSchema,
        detalle({ cabecera: { ...cabecera, moneda: "EUR" } }),
      ),
    ).toBe(false);
    expect(
      ok(
        detalleLupaSchema,
        detalle({ cabecera: { ...cabecera, origenSerie: "X" } }),
      ),
    ).toBe(false);
    for (const origenSerie of ["E", "F", null]) {
      expect(
        ok(
          detalleLupaSchema,
          detalle({ cabecera: { ...cabecera, origenSerie } }),
        ),
      ).toBe(true);
    }
  });

  it("la cabecera en USD lleva el tipo de cambio como texto; number se rechaza", () => {
    expect(
      ok(
        detalleLupaSchema,
        detalle({
          cabecera: { ...cabecera, moneda: "USD", tipoCambio: "3.752" },
        }),
      ),
    ).toBe(true);
    expect(
      ok(
        detalleLupaSchema,
        detalle({
          cabecera: { ...cabecera, moneda: "USD", tipoCambio: 3.752 },
        }),
      ),
    ).toBe(false);
  });

  it("la razón social puede ser null y proveedorNuevo es booleano", () => {
    expect(
      ok(
        detalleLupaSchema,
        detalle({ cabecera: { ...cabecera, razonSocial: null } }),
      ),
    ).toBe(true);
    expect(
      ok(
        detalleLupaSchema,
        detalle({ cabecera: { ...cabecera, proveedorNuevo: "si" } }),
      ),
    ).toBe(false);
  });
});

describe("detalleLupaSchema · ítems", () => {
  it("admite 2.000 ítems y rechaza 2.001", () => {
    expect(
      ok(
        detalleLupaSchema,
        detalle({ items: Array.from({ length: 2000 }, () => item) }),
      ),
    ).toBe(true);
    expect(
      ok(
        detalleLupaSchema,
        detalle({ items: Array.from({ length: 2001 }, () => item) }),
      ),
    ).toBe(false);
  });

  it("admite cero ítems (comprobante sin líneas legibles)", () => {
    expect(ok(detalleLupaSchema, detalle({ items: [] }))).toBe(true);
  });

  it("rechaza una glosa de 501 caracteres dentro del detalle", () => {
    expect(
      ok(
        detalleLupaSchema,
        detalle({ items: [{ ...item, descripcion: "a".repeat(501) }] }),
      ),
    ).toBe(false);
  });

  it("rechaza un monto de ítem como number dentro del detalle", () => {
    expect(
      ok(detalleLupaSchema, detalle({ items: [{ ...item, valor: 41.48 }] })),
    ).toBe(false);
  });
});

describe("detalleLupaSchema · comparación (D-9)", () => {
  it.each([
    "bi",
    "igv",
    "noGravado",
    "isc",
    "icbper",
    "otrosTributos",
    "total",
  ])("acepta la columna %s", (columna) => {
    expect(
      ok(
        detalleLupaSchema,
        detalle({ comparacion: [{ ...comparacionFila, columna }] }),
      ),
    ).toBe(true);
  });

  it("rechaza una columna desconocida", () => {
    expect(
      ok(
        detalleLupaSchema,
        detalle({ comparacion: [{ ...comparacionFila, columna: "biDg" }] }),
      ),
    ).toBe(false);
  });

  it("una diferencia lleva la regla y la explicación; ambas son opcionales", () => {
    const fila = {
      columna: "igv",
      sire: "21.48",
      xml: "1.61",
      difiere: true,
      regla: "R-MIX",
      explicacion: "Gravado y exonerado mezclados",
    };
    expect(ok(detalleLupaSchema, detalle({ comparacion: [fila] }))).toBe(true);
    expect(
      ok(
        detalleLupaSchema,
        detalle({ comparacion: [{ ...fila, regla: "R-ZZ" }] }),
      ),
    ).toBe(false);
  });

  it("sin XML la columna del XML es null", () => {
    expect(
      ok(
        detalleLupaSchema,
        detalle({
          comparacion: [{ ...comparacionFila, xml: null, difiere: false }],
        }),
      ),
    ).toBe(true);
  });

  it("los montos de la comparación son texto, nunca number", () => {
    expect(
      ok(
        detalleLupaSchema,
        detalle({ comparacion: [{ ...comparacionFila, sire: 1.61 }] }),
      ),
    ).toBe(false);
    expect(
      ok(
        detalleLupaSchema,
        detalle({ comparacion: [{ ...comparacionFila, xml: 1.61 }] }),
      ),
    ).toBe(false);
  });

  it("difiere es booleano obligatorio", () => {
    expect(
      ok(
        detalleLupaSchema,
        detalle({ comparacion: [sin(comparacionFila, "difiere")] }),
      ),
    ).toBe(false);
  });
});

describe("detalleLupaSchema · hallazgos e historial del proveedor", () => {
  it("los hallazgos tienen la forma de 014", () => {
    expect(
      ok(
        detalleLupaSchema,
        detalle({ hallazgos: [{ ...hallazgo, regla: "R-XX" }] }),
      ),
    ).toBe(false);
    expect(ok(detalleLupaSchema, detalle({ hallazgos: [] }))).toBe(true);
  });

  it("el historial admite 50 compras y rechaza 51", () => {
    expect(
      ok(
        detalleLupaSchema,
        detalle({
          historialProveedor: Array.from({ length: 50 }, () => historial),
        }),
      ),
    ).toBe(true);
    expect(
      ok(
        detalleLupaSchema,
        detalle({
          historialProveedor: Array.from({ length: 51 }, () => historial),
        }),
      ),
    ).toBe(false);
  });

  it("el historial trae periodo AAAAMM, las tres bases como texto y excluida", () => {
    expect(
      ok(
        detalleLupaSchema,
        detalle({ historialProveedor: [{ ...historial, periodo: "2026-09" }] }),
      ),
    ).toBe(false);
    expect(
      ok(
        detalleLupaSchema,
        detalle({ historialProveedor: [{ ...historial, periodo: "202613" }] }),
      ),
    ).toBe(false);
    expect(
      ok(
        detalleLupaSchema,
        detalle({ historialProveedor: [{ ...historial, biDg: 100 }] }),
      ),
    ).toBe(false);
    expect(
      ok(
        detalleLupaSchema,
        detalle({ historialProveedor: [{ ...historial, excluida: "no" }] }),
      ),
    ).toBe(false);
  });
});

describe("detalleLupaSchema · xml como unión discriminada", () => {
  const xml = (valor: unknown) =>
    ok(detalleLupaSchema, detalle({ xml: valor }));

  it("disponible exige origen simulado, real o subido", () => {
    for (const origen of ["simulado", "real", "subido"])
      expect(xml({ estado: "disponible", origen })).toBe(true);
    expect(xml({ estado: "disponible" })).toBe(false);
    expect(xml({ estado: "disponible", origen: "fixture" })).toBe(false);
  });

  it("disponible admite quién y cuándo lo subió, y el aviso de moneda", () => {
    const completo = {
      estado: "disponible",
      origen: "subido",
      subidoPor: randomUUID(),
      subidoEn: "2026-11-09T10:00:00.000Z",
      avisoMoneda: { monedaXml: "USD", monedaFila: "PEN" },
    };
    expect(xml(completo)).toBe(true);
    expect(xml({ ...completo, subidoPor: "no-es-uuid" })).toBe(false);
    expect(xml({ ...completo, subidoEn: "ayer" })).toBe(false);
    expect(
      xml({
        ...completo,
        avisoMoneda: { monedaXml: "EUR", monedaFila: "PEN" },
      }),
    ).toBe(false);
  });

  it("pendiente y sin_solicitar no llevan más datos", () => {
    expect(xml({ estado: "pendiente" })).toBe(true);
    expect(xml({ estado: "sin_solicitar" })).toBe(true);
  });

  it.each(["no_encontrado", "credencial", "transitorio", "no_aplica"])(
    "no_disponible admite el código %s",
    (codigo) => {
      expect(xml({ estado: "no_disponible", codigo })).toBe(true);
    },
  );

  it("no_disponible exige un código conocido", () => {
    expect(xml({ estado: "no_disponible" })).toBe(false);
    expect(xml({ estado: "no_disponible", codigo: "otro" })).toBe(false);
  });

  it("rechaza un estado desconocido o ausente", () => {
    expect(xml({ estado: "descargando" })).toBe(false);
    expect(xml({})).toBe(false);
    expect(xml("disponible")).toBe(false);
    expect(xml(null)).toBe(false);
  });

  it("un código de no_disponible no se cuela en otro estado ni se filtran datos del XML", () => {
    const r = detalleLupaSchema.parse(
      detalle({
        xml: {
          estado: "pendiente",
          codigo: "credencial",
          ruta: "xml/t/c/u.xml",
        },
      }),
    ) as { xml: Record<string, unknown> };
    expect(r.xml).toEqual({ estado: "pendiente" });
  });

  it("el estado disponible no devuelve la ruta de storage ni el hash", () => {
    const r = detalleLupaSchema.parse(
      detalle({
        xml: {
          estado: "disponible",
          origen: "real",
          ruta: "xml/t/c/u.xml",
          sha256: "ab",
        },
      }),
    ) as { xml: Record<string, unknown> };
    expect(r.xml).not.toHaveProperty("ruta");
    expect(r.xml).not.toHaveProperty("sha256");
  });
});

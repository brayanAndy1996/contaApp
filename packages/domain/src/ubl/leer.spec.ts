// Spec 016 · T2 (rojo). `leerUbl`: bytes → `DetalleXml` con los montos de D-2. CA-3, CA-4, CA-5.
// Contrato (plan, Contratos: Dominio): `leerUbl(bytes: Uint8Array) → DetalleXml`; lanza `UblError` con
// `codigo: "xml_invalido" | "xml_incompleto"` sin contenido. Forma de `DetalleXml`: ver tests/ayudas/ubl.ts.
import { describe, expect, it } from "vitest";
import { codificar } from "../texto/index";
import { FIXTURES, RUC_CLIENTE, linea, ubl, ublSintetico, subtotal, unir, utf8 } from "../../tests/ayudas/ubl";
import { UblError, leerUbl } from "./index";

const leer = (texto: string) => leerUbl(utf8(texto));
const fallo = (texto: string | Uint8Array): UblError => {
  try {
    leerUbl(typeof texto === "string" ? utf8(texto) : texto);
  } catch (e) {
    expect(e).toBeInstanceOf(UblError);
    return e as UblError;
  }
  throw new Error("se esperaba que leerUbl lanzara");
};

describe("leerUbl · los cinco fixtures de 009 (CA-3, CA-4, CA-5)", () => {
  it("F001-2056 (mixta): gravado 8.97, IGV 1.61, no gravado 12.51 (9997), total 23.09", () => {
    const d = leer(FIXTURES.mixta);
    expect(d.totales).toEqual({ gravado: "8.97", igv: "1.61", noGravado: "12.51", isc: "0.00", icbper: "0.00", otros: "0.00", total: "23.09" });
    expect(d.moneda).toBe("PEN");
    expect(d.monedaUnica).toBe(true);
    expect(d.raiz).toBe("Invoice");
    expect(d.fecha).toBe("2026-10-05");
  });

  it("F001-2056: identidad con emisor, receptor y número sin ceros", () => {
    expect(leer(FIXTURES.mixta).identidad).toEqual({
      tipo: "01",
      serie: "F001",
      numero: "2056",
      emisor: { ruc: "20700000045", razonSocial: "PRUEBA PROVEEDOR MIXTO S.A.C." },
      receptor: { tipoDoc: "6", numero: RUC_CLIENTE },
    });
  });

  it("F001-2056: dos ítems con afectación, valor, precio unitario y su IGV; los TaxTotal de línea no suman al documento", () => {
    const { items } = leer(FIXTURES.mixta);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ descripcion: "Producto gravado de prueba (PRUEBA)", cantidad: "1", unidad: "NIU", precioUnitario: "8.97", valor: "8.97", afectacion: "gravado", igv: "1.61" });
    expect(items[1]).toMatchObject({ descripcion: "Producto exonerado de prueba (PRUEBA)", valor: "12.51", afectacion: "exonerado", igv: "0.00" });
  });

  it("F001-1040 (San Juan): subtotal ISC sin TaxableAmount → gravado 0.00, ISC 770.00, total 770.00 sin error", () => {
    const d = leer(FIXTURES.sanJuan);
    expect(d.totales).toMatchObject({ gravado: "0.00", igv: "0.00", noGravado: "0.00", isc: "770.00", icbper: "0.00", total: "770.00" });
    expect(d.items).toHaveLength(1);
    expect(d.items[0]).toMatchObject({ precioUnitario: "0.00", valor: "0.00", isc: "770.00" });
  });

  it("F001-3064 (ICBPER 7152): ICBPER 1.50 e IGV 18.00; el ICBPER de la línea es del ítem, no del documento dos veces", () => {
    const d = leer(FIXTURES.icbper);
    expect(d.totales).toMatchObject({ gravado: "100.00", igv: "18.00", icbper: "1.50", total: "119.50" });
    expect(d.items).toHaveLength(2);
    expect(d.items[1]).toMatchObject({ cantidad: "3", icbper: "1.50" });
  });

  it("F001-5070 (zapatilla): la glosa de la línea llega como texto", () => {
    const d = leer(FIXTURES.zapatilla);
    expect(d.items[0]?.descripcion).toContain("Par de zapatillas deportivas de prueba");
    expect(d.totales).toMatchObject({ gravado: "150.00", igv: "27.00", total: "177.00" });
  });

  it("F001-4062 (USD): moneda USD, BI 0.15, IGV 0.03, total 0.18", () => {
    const d = leer(FIXTURES.usd);
    expect(d.moneda).toBe("USD");
    expect(d.monedaUnica).toBe(true);
    expect(d.totales).toMatchObject({ gravado: "0.15", igv: "0.03", total: "0.18" });
  });

  it("leer dos veces el mismo XML da el mismo resultado", () => {
    expect(leer(FIXTURES.mixta)).toEqual(leer(FIXTURES.mixta));
  });
});

describe("leerUbl · codificación y prefijos de espacio de nombres (CA-3)", () => {
  // 2056 re-codificado en ISO-8859-1, con otros prefijos y caracteres que solo existen en Latin-1.
  const reprefijado = FIXTURES.mixta
    .replace(/<\?xml[^>]*\?>/, '<?xml version="1.0" encoding="ISO-8859-1"?>')
    .replace("xmlns:cbc=", "xmlns:b=")
    .replace("xmlns:cac=", "xmlns:a=")
    .replace(/<(\/?)cbc:/g, "<$1b:")
    .replace(/<(\/?)cac:/g, "<$1a:")
    .replace("Producto gravado de prueba (PRUEBA)", "Producto gravado de prueba (PRUEBA) año ñandú");

  it("ISO-8859-1 con otros prefijos da los mismos montos que el original", () => {
    const bytes = codificar(reprefijado, "latin1");
    expect(Array.from(bytes).includes(0xf1)).toBe(true); // la ñ ocupa un solo byte: de verdad es Latin-1
    const d = leerUbl(bytes);
    expect(d.totales).toEqual(leer(FIXTURES.mixta).totales);
    expect(d.identidad).toEqual(leer(FIXTURES.mixta).identidad);
    expect(d.items[0]?.descripcion).toBe("Producto gravado de prueba (PRUEBA) año ñandú");
  });

  it("la declaración en minúsculas (utf-8, iso-8859-1) se acepta", () => {
    const utf = ubl({ declaracion: '<?xml version="1.0" encoding="utf-8"?>\n' });
    expect(leer(utf).totales.total).toBe("118.00");
    const lat = ubl({ declaracion: '<?xml version="1.0" encoding="iso-8859-1"?>\n' });
    expect(leerUbl(codificar(lat, "latin1")).totales.total).toBe("118.00");
  });

  it("sin declaración se asume UTF-8", () => {
    const d = leer(ubl({ declaracion: null, lineas: [linea({ descripcion: "Año nuevo ñandú" })] }));
    expect(d.items[0]?.descripcion).toBe("Año nuevo ñandú");
  });

  it("prefijos de espacio de nombres cualesquiera (x1, x2) dan lo mismo", () => {
    const texto = ubl()
      .replace("xmlns:cbc=", "xmlns:x1=")
      .replace("xmlns:cac=", "xmlns:x2=")
      .replace(/<(\/?)cbc:/g, "<$1x1:")
      .replace(/<(\/?)cac:/g, "<$1x2:");
    expect(leer(texto).totales).toMatchObject({ gravado: "100.00", igv: "18.00", total: "118.00" });
  });

  it("UTF-8 estricto: una secuencia inválida es xml_invalido (nunca U+FFFD)", () => {
    const [antes, despues] = ubl({ lineas: [linea({ descripcion: "@@" })] }).split("@@") as [string, string];
    const e = fallo(unir(utf8(antes), Uint8Array.of(0xc3, 0x28), utf8(despues)));
    expect(e.codigo).toBe("xml_invalido");
  });
});

describe("leerUbl · el UBL sintético de 009", () => {
  it("sin ISC: ISC 0.00", () => {
    const d = leer(ublSintetico({ base: "100.00", igv: "18.00", isc: "0.00", total: "118.00" }));
    expect(d.totales).toMatchObject({ gravado: "100.00", igv: "18.00", isc: "0.00", total: "118.00" });
    expect(d.identidad.receptor).toEqual({ tipoDoc: "0", numero: "-" });
  });

  it("con ISC: ISC 5.00 y el IGV no se mezcla con el ISC aunque compartan base", () => {
    const d = leer(ublSintetico({ base: "100.00", igv: "18.00", isc: "5.00", total: "123.00" }));
    expect(d.totales).toMatchObject({ gravado: "100.00", igv: "18.00", isc: "5.00", total: "123.00" });
  });

  it("en USD", () => {
    const d = leer(ublSintetico({ base: "10.00", igv: "1.80", isc: "0.00", total: "11.80", moneda: "USD" }));
    expect(d.moneda).toBe("USD");
    expect(d.totales).toMatchObject({ gravado: "10.00", igv: "1.80", total: "11.80" });
  });
});

describe("leerUbl · D-2: mapeo por esquema de impuesto", () => {
  it("9997 y 9998 suman en no gravado", () => {
    const d = leer(ubl({ subtotales: [subtotal("9997", "12.51", "0.00"), subtotal("9998", "5.00", "0.00")], pagable: "17.51", incluyeImpuestos: "17.51" }));
    expect(d.totales).toMatchObject({ gravado: "0.00", igv: "0.00", noGravado: "17.51", total: "17.51" });
  });

  it("9999 va a «otros» y no entra en gravado, IGV, ISC ni ICBPER", () => {
    const d = leer(ubl({ subtotales: [subtotal("1000", "100.00", "18.00"), subtotal("9999", null, "3.00")], pagable: "121.00", incluyeImpuestos: "121.00" }));
    expect(d.totales).toMatchObject({ gravado: "100.00", igv: "18.00", isc: "0.00", icbper: "0.00", otros: "3.00", total: "121.00" });
  });

  it("9995 y 9996 (gratuitas) no suman a ninguna columna ni al total", () => {
    const d = leer(
      ubl({
        subtotales: [subtotal("1000", "100.00", "18.00"), subtotal("9996", "50.00", "9.00"), subtotal("9995", "20.00", "0.00")],
        lineas: [linea({ valor: "100.00" }), linea({ n: "2", valor: "50.00", descripcion: "Obsequio" })],
      }),
    );
    expect(d.totales).toMatchObject({ gravado: "100.00", igv: "18.00", noGravado: "0.00", isc: "0.00", otros: "0.00", total: "118.00" });
    expect(d.items.map((i) => i.descripcion)).toContain("Obsequio");
  });

  it("un subtotal 1000 sin TaxableAmount toma la base de la suma de las líneas de esa afectación", () => {
    const d = leer(
      ubl({
        subtotales: [subtotal("1000", null, "18.00")],
        lineas: [
          linea({ valor: "60.00", subtotales: [subtotal("1000", "60.00", "10.80")] }),
          linea({ n: "2", valor: "40.00", subtotales: [subtotal("1000", "40.00", "7.20")] }),
        ],
      }),
    );
    expect(d.totales).toMatchObject({ gravado: "100.00", igv: "18.00", total: "118.00" });
  });

  it("un subtotal sin TaxableAmount y sin líneas de esa afectación da base 0.00", () => {
    const d = leer(ubl({ subtotales: [subtotal("1000", null, "0.00")], lineas: [linea()], pagable: "0.00", incluyeImpuestos: "0.00" }));
    expect(d.totales).toMatchObject({ gravado: "0.00", igv: "0.00", total: "0.00" });
  });

  it("el total es PayableAmount; sin él, TaxInclusiveAmount", () => {
    expect(leer(ubl({ pagable: "117.00", incluyeImpuestos: "118.00" })).totales.total).toBe("117.00");
    expect(leer(ubl({ pagable: null, incluyeImpuestos: "118.00" })).totales.total).toBe("118.00");
    expect(leer(ubl({ pagable: "117.00", incluyeImpuestos: null })).totales.total).toBe("117.00");
  });

  it("sin PayableAmount ni TaxInclusiveAmount es xml_incompleto", () => {
    expect(fallo(ubl({ pagable: null, incluyeImpuestos: null })).codigo).toBe("xml_incompleto");
  });

  it("el número se guarda sin ceros a la izquierda", () => {
    const d = leer(ubl({ id: "F001-00002056" }));
    expect(d.identidad).toMatchObject({ serie: "F001", numero: "2056" });
  });

  it("boleta (03): el tipo sale del InvoiceTypeCode", () => {
    expect(leer(ubl({ tipo: "03", id: "B001-291" })).identidad).toMatchObject({ tipo: "03", serie: "B001", numero: "291" });
  });

  it("el precio unitario se guarda exacto como texto, sin redondear", () => {
    const d = leer(ubl({ lineas: [linea({ precio: "12.3456789", cantidad: "2.5" })] }));
    expect(d.items[0]).toMatchObject({ precioUnitario: "12.3456789", cantidad: "2.5" });
  });
});

describe("leerUbl · notas de crédito y débito, moneda mixta, redondeo, rango", () => {
  const nota = (raiz: "CreditNote" | "DebitNote") =>
    ubl({ raiz, id: "FC01-15", lineas: [linea({ raiz })], subtotales: [subtotal("1000", "100.00", "18.00"), subtotal("9997", "20.00", "0.00")], pagable: "138.00", incluyeImpuestos: "138.00" });

  it("nota de crédito (07): montos en negativo y tipo 07", () => {
    const d = leer(nota("CreditNote"));
    expect(d.raiz).toBe("CreditNote");
    expect(d.identidad).toMatchObject({ tipo: "07", serie: "FC01", numero: "15" });
    expect(d.totales).toMatchObject({ gravado: "-100.00", igv: "-18.00", noGravado: "-20.00", total: "-138.00" });
  });

  it("nota de débito (08): montos positivos y tipo 08", () => {
    const d = leer(nota("DebitNote"));
    expect(d.raiz).toBe("DebitNote");
    expect(d.identidad.tipo).toBe("08");
    expect(d.totales).toMatchObject({ gravado: "100.00", igv: "18.00", total: "138.00" });
  });

  it("currencyID mezclado: monedaUnica = false y la moneda es la del documento", () => {
    const texto = ubl({ subtotales: [subtotal("1000", "100.00", "18.00"), subtotal("2000", null, "5.00", "USD")], pagable: "123.00", incluyeImpuestos: "123.00" });
    const d = leer(texto);
    expect(d.moneda).toBe("PEN");
    expect(d.monedaUnica).toBe(false);
  });

  it("currencyID de los totales distinto del documento también es monedaUnica = false", () => {
    expect(leer(ubl({ moneda: "PEN", monedaTotales: "USD" })).monedaUnica).toBe(false);
  });

  it("más de 2 decimales se redondean con redondearSunat (mitad hacia afuera, no al par)", () => {
    const d = leer(
      ubl({
        subtotales: [subtotal("1000", "8.965", "1.614"), subtotal("9997", "0.125", "0.00"), subtotal("2000", null, "2.675")],
        pagable: "23.095",
        incluyeImpuestos: "23.095",
      }),
    );
    expect(d.totales).toMatchObject({ gravado: "8.97", igv: "1.61", noGravado: "0.13", isc: "2.68", total: "23.10" });
  });

  it("redondeo en una nota de crédito: lejos de cero (-8.965 → -8.97)", () => {
    const d = leer(ubl({ raiz: "CreditNote", subtotales: [subtotal("1000", "8.965", "1.61")], lineas: [linea({ raiz: "CreditNote" })], pagable: "10.575", incluyeImpuestos: "10.575" }));
    expect(d.totales).toMatchObject({ gravado: "-8.97", igv: "-1.61", total: "-10.58" });
  });

  it("ningún monto sale con más de 2 decimales ni en notación científica", () => {
    const d = leer(ubl({ subtotales: [subtotal("1000", "100.0000", "18.0")], pagable: "118", incluyeImpuestos: "118" }));
    for (const v of Object.values(d.totales)) expect(v).toMatch(/^-?\d+\.\d{2}$/);
  });

  it("el tope de NUMERIC(14,2): 999999999999.99 cabe; 1000000000000.00 es xml_invalido", () => {
    expect(leer(ubl({ pagable: "999999999999.99", incluyeImpuestos: "999999999999.99" })).totales.total).toBe("999999999999.99");
    expect(fallo(ubl({ pagable: "1000000000000.00", incluyeImpuestos: "1000000000000.00" })).codigo).toBe("xml_invalido");
    expect(fallo(ubl({ subtotales: [subtotal("1000", "100.00", "1000000000000.00")] })).codigo).toBe("xml_invalido");
  });

  it("un monto que no es número es xml_invalido", () => {
    expect(fallo(ubl({ pagable: "abc", incluyeImpuestos: null })).codigo).toBe("xml_invalido");
  });
});

describe("leerUbl · tolerancia, glosas y texto no confiable (D-1, D-2)", () => {
  it("ignora UBLExtensions (firma), comentarios y elementos desconocidos; los montos de la extensión no cuentan", () => {
    const extensiones =
      "<!-- firma --><ext:UBLExtensions xmlns:ext=\"urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2\">" +
      "<ext:UBLExtension><ext:ExtensionContent><cac:LegalMonetaryTotal><cbc:PayableAmount currencyID=\"PEN\">999.99</cbc:PayableAmount></cac:LegalMonetaryTotal>" +
      "<cbc:TaxAmount currencyID=\"PEN\">500.00</cbc:TaxAmount></ext:ExtensionContent></ext:UBLExtension></ext:UBLExtensions>";
    const d = leer(ubl({ extensiones, final: "<cbc:Desconocido>1</cbc:Desconocido><!-- fin -->" }));
    expect(d.totales).toMatchObject({ gravado: "100.00", igv: "18.00", total: "118.00" });
  });

  it("la glosa de más de 500 caracteres se recorta a 500", () => {
    const d = leer(ubl({ lineas: [linea({ descripcion: "a".repeat(600) })] }));
    expect(d.items[0]?.descripcion).toBe("a".repeat(500));
  });

  it("una glosa con <script> llega intacta como texto (CDATA), sin interpretarse", () => {
    const d = leer(ubl({ lineas: [linea({ descripcion: "<![CDATA[<script>alert('x')</script>]]>" })] }));
    expect(d.items[0]?.descripcion).toBe("<script>alert('x')</script>");
  });

  it("lo que no es XML, un XML mal formado o una raíz que no es UBL son xml_invalido", () => {
    expect(fallo("esto no es un XML").codigo).toBe("xml_invalido");
    expect(fallo("").codigo).toBe("xml_invalido");
    expect(fallo(ubl().replace("</cbc:ID>", "")).codigo).toBe("xml_invalido");
    expect(fallo("<html><body>hola</body></html>").codigo).toBe("xml_invalido");
  });

  it("el error de un XML mal formado no repite el contenido", () => {
    const e = fallo(ubl({ lineas: [linea({ descripcion: "CANARIO_LEER_77" })] }).replace("</cac:Item>", ""));
    expect(`${e.message} ${String(e)}`).not.toContain("CANARIO_LEER_77");
  });
});

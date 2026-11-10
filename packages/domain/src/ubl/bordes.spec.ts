// Spec 016 · T8 (backend). Bordes del parser UBL que no cubren las pruebas de T2: UTF-8 estricto byte a byte, BOM,
// entidades predefinidas y numéricas, campos ausentes o fuera de gramática, notas de débito con `RequestedMonetaryTotal`,
// bases tomadas de las líneas exoneradas e inafectas, y el resumen de un XML en USD con monedas mezcladas.
import { describe, expect, it } from "vitest";
import { codificar } from "../texto/index";
import { RUC_CLIENTE, detalleMixta, linea, subtotal, ubl, unir, utf8 } from "../../tests/ayudas/ubl";
import { UblError, aResumenXml, leerUbl } from "./index";

const leer = (texto: string) => leerUbl(utf8(texto));
const codigo = (entrada: string | Uint8Array): string => {
  try {
    leerUbl(typeof entrada === "string" ? utf8(entrada) : entrada);
  } catch (e) {
    expect(e).toBeInstanceOf(UblError);
    expect((e as UblError).cause).toBeUndefined();
    return (e as UblError).codigo;
  }
  throw new Error("se esperaba que leerUbl lanzara");
};
/** El XML de `ubl()` con `bytes` en lugar de la glosa de la línea. */
const conBytes = (...bytes: readonly number[]): Uint8Array => {
  const [antes, despues] = ubl({ lineas: [linea({ descripcion: "@@" })] }).split("@@") as [string, string];
  return unir(utf8(antes), Uint8Array.from(bytes), utf8(despues));
};

describe("decodificar · UTF-8 estricto", () => {
  it("2, 3 y 4 bytes se decodifican (ñ, €, emoji como par sustituto)", () => {
    const d = leerUbl(conBytes(0xc3, 0xb1, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80));
    expect(d.items[0]?.descripcion).toBe("ñ€😀");
  });

  it.each([
    ["byte de continuación suelto", [0x80]],
    ["inicio no válido (C0, overlong)", [0xc0, 0x80]],
    ["inicio no válido (F5)", [0xf5, 0x80, 0x80, 0x80]],
    ["3 bytes sin continuación", [0xe2, 0x82, 0x28]],
    ["3 bytes overlong (E0 80 80)", [0xe0, 0x80, 0x80]],
    ["sustituto codificado (ED A0 80)", [0xed, 0xa0, 0x80]],
    ["4 bytes sin continuación", [0xf0, 0x9f, 0x98, 0x28]],
    ["4 bytes overlong (F0 80 80 80)", [0xf0, 0x80, 0x80, 0x80]],
    ["fuera de rango (F4 90 80 80)", [0xf4, 0x90, 0x80, 0x80]],
    ["truncado al final", [0xe2, 0x82]],
  ])("%s es xml_invalido", (_nombre, bytes) => {
    expect(codigo(conBytes(...bytes))).toBe("xml_invalido");
  });

  it("BOM UTF-8 con declaración UTF-8 se acepta; con ISO-8859-1 es xml_invalido", () => {
    expect(leerUbl(unir(Uint8Array.of(0xef, 0xbb, 0xbf), utf8(ubl()))).totales.total).toBe("118.00");
    const latin = ubl({ declaracion: '<?xml version="1.0" encoding="ISO-8859-1"?>\n' });
    expect(codigo(unir(Uint8Array.of(0xef, 0xbb, 0xbf), codificar(latin, "latin1")))).toBe("xml_invalido");
  });

  it("una declaración sin encoding es UTF-8", () => {
    const d = leer(ubl({ declaracion: '<?xml version="1.0"?>\n', lineas: [linea({ descripcion: "Año" })] }));
    expect(d.items[0]?.descripcion).toBe("Año");
  });
});

describe("escaneo · construcciones sin cerrar y etiquetas rotas", () => {
  it.each([
    ["comentario sin cerrar", "<!-- sin cierre"],
    ["CDATA sin cerrar", "<cbc:Nota><![CDATA[sin cierre"],
    ["instrucción sin cerrar", "<?pi sin cierre"],
    ["etiqueta sin cerrar", "<cbc:Nota a=\"1\""],
    ["< dentro de una etiqueta", "<cbc:Nota <b>"],
  ])("%s es xml_invalido", (_nombre, final) => {
    expect(codigo(`${ubl().trimEnd()}${final}`)).toBe("xml_invalido");
  });

  it("un > dentro de un atributo entre comillas no cierra la etiqueta", () => {
    expect(leer(ubl({ final: `<cbc:Nota a="x>y" b='1>2'/>` })).totales.total).toBe("118.00");
  });
});

describe("leerUbl · entradas que no son UBL", () => {
  it("lo que no es Uint8Array es xml_invalido", () => {
    expect(codigo("x" as unknown as Uint8Array)).toBe("xml_invalido");
  });

  it("un nombre de elemento reservado (constructor) es xml_invalido sin citarlo", () => {
    expect(codigo(ubl({ final: "<constructor>1</constructor>" }))).toBe("xml_invalido");
  });

  it("una moneda que no es PEN ni USD es xml_invalido", () => {
    expect(codigo(ubl({ moneda: "EUR" }))).toBe("xml_invalido");
  });
});

describe("leerUbl · entidades predefinidas y numéricas (sin DOCTYPE)", () => {
  it("&amp; &lt; &gt; &quot; &apos; y &#241; &#xF1; se resuelven; una referencia no válida queda literal", () => {
    const d = leer(ubl({ lineas: [linea({ descripcion: "P&amp;H &lt;b&gt; &quot;x&quot; &apos;y&apos; &#241;&#xF1; &#1;" })] }));
    expect(d.items[0]?.descripcion).toBe(`P&H <b> "x" 'y' ññ &#1;`);
  });

  it("la razón social con &amp; se resuelve", () => {
    const d = leer(ubl({ emisor: { ruc: "20700000045", razonSocial: "PEREZ &amp; HIJOS S.A.C." } }));
    expect(d.identidad.emisor.razonSocial).toBe("PEREZ & HIJOS S.A.C.");
  });
});

describe("leerUbl · campos obligatorios y gramáticas", () => {
  it.each([
    ["sin ID", (x: string) => x.replace("<cbc:ID>F001-2056</cbc:ID>", "")],
    ["ID vacío", (x: string) => x.replace("<cbc:ID>F001-2056</cbc:ID>", "<cbc:ID></cbc:ID>")],
    ["sin IssueDate", (x: string) => x.replace(/<cbc:IssueDate>[^<]*<\/cbc:IssueDate>/, "")],
    ["sin DocumentCurrencyCode", (x: string) => x.replace(/<cbc:DocumentCurrencyCode>[^<]*<\/cbc:DocumentCurrencyCode>/, "")],
    ["sin InvoiceTypeCode", (x: string) => x.replace(/<cbc:InvoiceTypeCode[^>]*>[^<]*<\/cbc:InvoiceTypeCode>/, "")],
    ["sin emisor", (x: string) => x.replace(/<cac:AccountingSupplierParty>.*<\/cac:AccountingSupplierParty>/, "")],
    ["sin receptor", (x: string) => x.replace(/<cac:AccountingCustomerParty>.*<\/cac:AccountingCustomerParty>/, "")],
  ])("%s es xml_incompleto", (_nombre, quitar) => {
    expect(codigo(quitar(ubl()))).toBe("xml_incompleto");
  });

  it.each([
    ["ID sin guion", { id: "F0012056" }],
    ["número de 9 dígitos", { id: "F001-123456789" }],
    ["tipo de una cifra", { tipo: "1" }],
    ["fecha con otro formato", { fecha: "05/10/2026" }],
    ["RUC de 10 dígitos", { emisor: { ruc: "2070000004", razonSocial: "X" } }],
    ["receptor con espacios", { receptor: { tipoDoc: "6", numero: "207 000" } }],
    ["tipo de receptor largo", { receptor: { tipoDoc: "666", numero: RUC_CLIENTE } }],
  ])("%s es xml_invalido", (_nombre, o) => {
    expect(codigo(ubl(o))).toBe("xml_invalido");
  });

  it("unidad o cantidad fuera de gramática son xml_invalido", () => {
    expect(codigo(ubl({ lineas: [linea({ unidad: "UNA UNIDAD MUY LARGA" })] }))).toBe("xml_invalido");
    expect(codigo(ubl({ lineas: [linea({ cantidad: "-1" })] }))).toBe("xml_invalido");
  });

  it("razón social: RegistrationName, si no PartyName/Name, si no vacía", () => {
    const base = ubl();
    const conNombre = base.replace(
      /<cac:PartyLegalEntity><cbc:RegistrationName>PRUEBA PROVEEDOR S\.A\.C\.<\/cbc:RegistrationName><\/cac:PartyLegalEntity>/,
      "<cac:PartyName><cbc:Name>NOMBRE COMERCIAL</cbc:Name></cac:PartyName>",
    );
    expect(leer(conNombre).identidad.emisor.razonSocial).toBe("NOMBRE COMERCIAL");
    const sinNombre = base.replace(/<cac:PartyLegalEntity><cbc:RegistrationName>PRUEBA PROVEEDOR[^<]*<\/cbc:RegistrationName><\/cac:PartyLegalEntity>/, "");
    expect(leer(sinNombre).identidad.emisor.razonSocial).toBe("");
  });

  it("tipo del receptor: schemeID, si no AdditionalAccountID, si no vacío", () => {
    const sinScheme = ubl().replace(`<cbc:ID schemeID="6">${RUC_CLIENTE}</cbc:ID>`, `<cbc:ID>${RUC_CLIENTE}</cbc:ID>`);
    expect(leer(sinScheme).identidad.receptor).toEqual({ tipoDoc: "", numero: RUC_CLIENTE });
    const conCuenta = sinScheme.replace("<cac:AccountingCustomerParty>", "<cac:AccountingCustomerParty><cbc:AdditionalAccountID>6</cbc:AdditionalAccountID>");
    expect(leer(conCuenta).identidad.receptor).toEqual({ tipoDoc: "6", numero: RUC_CLIENTE });
  });

  it("la glosa se recorta sin dejar medio par sustituto", () => {
    const d = leer(ubl({ lineas: [linea({ descripcion: `${"a".repeat(499)}😀b` })] }));
    expect(d.items[0]?.descripcion).toBe("a".repeat(499));
  });
});

describe("leerUbl · líneas y totales", () => {
  it("afectación por esquema de la línea: exonerado, inafecto, exportación, gratuito y otro", () => {
    const d = leer(
      ubl({
        lineas: [
          linea({ n: "1", subtotales: [subtotal("9997", "10.00", "0.00")] }),
          linea({ n: "2", subtotales: [subtotal("9998", "10.00", "0.00")] }),
          linea({ n: "3", subtotales: [subtotal("9995", "10.00", "0.00")] }),
          linea({ n: "4", subtotales: [subtotal("9996", "10.00", "1.80")] }),
          linea({ n: "5", subtotales: [subtotal("2000", null, "5.00")] }),
        ],
      }),
    );
    expect(d.items.map((i) => i.afectacion)).toEqual(["exonerado", "inafecto", "exportacion", "gratuito", "otro"]);
    expect(d.items[4]).toMatchObject({ isc: "5.00", igv: "0.00" });
  });

  it("subtotales 9997 y 9998 sin TaxableAmount toman la base de sus líneas; un esquema desconocido no suma", () => {
    const d = leer(
      ubl({
        subtotales: [subtotal("9997", null, "0.00"), subtotal("9998", null, "0.00"), subtotal("1016", "50.00", "2.00")],
        lineas: [
          linea({ n: "1", valor: "30.00", subtotales: [subtotal("9997", "30.00", "0.00")] }),
          linea({ n: "2", valor: "20.00", subtotales: [subtotal("9998", "20.00", "0.00")] }),
        ],
        pagable: "50.00",
        incluyeImpuestos: "50.00",
      }),
    );
    expect(d.totales).toMatchObject({ gravado: "0.00", igv: "0.00", noGravado: "50.00", otros: "0.00", total: "50.00" });
  });

  it("una línea sin precio ni cantidad: precio 0, cantidad 0 y unidad vacía", () => {
    const sinPrecio = linea({ n: "1" })
      .replace(/<cac:Price>.*<\/cac:Price>/, "")
      .replace(/<cbc:InvoicedQuantity[^>]*>[^<]*<\/cbc:InvoicedQuantity>/, "");
    expect(leer(ubl({ lineas: [sinPrecio] })).items[0]).toMatchObject({ precioUnitario: "0", cantidad: "0", unidad: "" });
  });

  it("un precio unitario que no es número es xml_invalido", () => {
    expect(codigo(ubl({ lineas: [linea({ precio: "1e3" })] }))).toBe("xml_invalido");
  });

  it("un TaxSubtotal sin TaxAmount cuenta 0.00", () => {
    const sinMonto = subtotal("1000", "100.00", "18.00").replace(/<cbc:TaxAmount[^>]*>18\.00<\/cbc:TaxAmount>/, "");
    expect(leer(ubl({ subtotales: [sinMonto] })).totales).toMatchObject({ gravado: "100.00", igv: "0.00" });
  });

  it("nota de débito con RequestedMonetaryTotal (UBL 2.1)", () => {
    const texto = ubl({ raiz: "DebitNote", id: "FD01-3", lineas: [linea({ raiz: "DebitNote" })] }).replace(/LegalMonetaryTotal/g, "RequestedMonetaryTotal");
    expect(leer(texto).totales.total).toBe("118.00");
  });

  it("la nota de crédito también lleva en negativo los importes de sus líneas (no el precio unitario)", () => {
    const d = leer(ubl({ raiz: "CreditNote", lineas: [linea({ raiz: "CreditNote", subtotales: [subtotal("1000", "100.00", "18.00")] })] }));
    expect(d.items[0]).toMatchObject({ valor: "-100.00", igv: "-18.00", precioUnitario: "100.00" });
  });

  it("un currencyID distinto en el precio unitario también es monedaUnica = false", () => {
    expect(leer(ubl({ lineas: [linea({ moneda: "USD" })] })).monedaUnica).toBe(false);
  });
});

describe("aResumenXml · USD con monedas mezcladas", () => {
  it("el total queda en PEN para que 011 emita XML_MONEDA", () => {
    const r = aResumenXml(detalleMixta({ moneda: "USD", monedaUnica: false }));
    expect(r.moneda).toBe("USD");
    expect(r.gravado.moneda).toBe("USD");
    expect(r.total.moneda).toBe("PEN");
  });
});

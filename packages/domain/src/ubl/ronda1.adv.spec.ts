// Spec 016 · T18 · ronda adversarial 1 sobre el parser UBL (D-1, D-2, D-3; CA-1, CA-2, CA-5).
// Caja negra (A1–A8, solo spec y API pública) y luego caja blanca (A9–A11, tras leer `ubl/{escaneo,decodificar,leer,montos}.ts`).
// No repite lo de T2 (`seguridad`, `leer`, `bordes`): ataca variantes. Una prueba en rojo es un hallazgo H-016-n.
import { describe, expect, it } from "vitest";
import { linea, subtotal, ubl, unir, utf8 } from "../../tests/ayudas/ubl";
import { UblError, leerUbl } from "./index";
import type { DetalleXml } from "./index";

const CANARIO = "CANARIO_ADV_7Q2";

/** Resultado de leer: el detalle o el código del `UblError` (cualquier otro error rompe la prueba). */
function leer(entrada: string | Uint8Array): DetalleXml | { codigo: string } {
  try {
    return leerUbl(typeof entrada === "string" ? utf8(entrada) : entrada);
  } catch (e) {
    expect(e).toBeInstanceOf(UblError);
    const u = e as UblError;
    expect([u.message, u.stack ?? ""].join("\n")).not.toContain(CANARIO);
    return { codigo: u.codigo };
  }
}
const esDetalle = (r: DetalleXml | { codigo: string }): r is DetalleXml => !("codigo" in r);
const invalido = { codigo: "xml_invalido" };

// ---------------------------------------------------------------------------------------------------------- caja negra
describe("T18 · caja negra · entidades y codificación", () => {
  it("A1 · entidades en todas sus formas: tras BOM, mayúsculas mezcladas, de parámetro, en atributos y referencias a caracteres prohibidos", () => {
    const bom = Uint8Array.of(0xef, 0xbb, 0xbf);
    const hostiles: (string | Uint8Array)[] = [
      unir(bom, utf8(`<!DOCTYPE Invoice [<!ENTITY x "${CANARIO}">]>\n${ubl({ declaracion: null })}`)),
      unir(bom, utf8(ubl({ declaracion: `<?xml version="1.0" encoding="UTF-8"?>\n<!doctype Invoice>\n` }))),
      ubl({ declaracion: `<?xml version="1.0"?>\n<!DocType Invoice [<!ENTITY % p SYSTEM "http://127.0.0.1:9/${CANARIO}"> %p;]>\n` }),
      ubl({ extensiones: `<!EnTiTy x "${CANARIO}">` }),
    ];
    for (const h of hostiles) expect(leer(h)).toEqual(invalido);

    // Sin DOCTYPE, una referencia a una entidad no declarada (en texto o en atributo) nunca se expande ni rompe el parser.
    const enAtributo = leer(ubl({ subtotales: [subtotal("1000", "100.00", "18.00", "&xxe;")], lineas: [linea({ descripcion: "&xxe; &lol9;" })] }));
    if (esDetalle(enAtributo)) {
      expect(enAtributo.items[0]!.descripcion).toBe("&xxe; &lol9;");
      expect(enAtributo.totales.igv).toBe("18.00");
    }
    // Referencias numéricas a caracteres que XML prohíbe: nunca llegan a la glosa como el carácter (NUL, control, sustituto).
    const prohibidos = leer(ubl({ lineas: [linea({ descripcion: "a&#0;b&#x1;c&#xD800;d&#x110000;e&#65535;" })] }));
    if (esDetalle(prohibidos)) {
      expect(prohibidos.items[0]!.descripcion).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff￿]/);
    }
  });

  it("A2 · declaración de codificación engañosa: un atributo parecido, dos `encoding` o un nombre con espacios no se leen como UTF-8", () => {
    const declaraciones = [
      '<?xml version="1.0" x-encoding="UTF-8" encoding="UTF-16"?>\n',
      '<?xml version="1.0" encoding="UTF-8" encoding="UTF-16"?>\n',
      '<?xml version="1.0" encoding=" UTF-16"?>\n',
    ];
    for (const declaracion of declaraciones) {
      expect(leer(ubl({ declaracion })), declaracion).toEqual(invalido);
    }
  });
});

describe("T18 · caja negra · contenido que intenta engañar al mapeo de montos", () => {
  it("A3 · comentarios y CDATA con montos falsos no cuentan; un comentario en medio de un importe no lo trunca", () => {
    const falso = `<cac:LegalMonetaryTotal><cbc:PayableAmount currencyID="PEN">9999.00</cbc:PayableAmount></cac:LegalMonetaryTotal>`;
    const enComentario = leer(ubl({ extensiones: `<!-- ${falso} -->` }));
    expect(esDetalle(enComentario) && enComentario.totales.total).toBe("118.00");
    const enCdata = leer(ubl({ extensiones: `<cbc:Note><![CDATA[${falso}]]></cbc:Note>` }));
    expect(esDetalle(enCdata) && enCdata.totales.total).toBe("118.00");
    // Texto «1» + comentario + «18.00»: el contenido del elemento es 118.00; cualquier otro importe es un error de lectura.
    const partido = leer(ubl({ pagable: "1<!-- x -->18.00", incluyeImpuestos: null }));
    if (esDetalle(partido)) expect(partido.totales.total).toBe("118.00");
    else expect(partido).toEqual(invalido);
  });

  it("A4 · TaxTotal del documento duplicado: el IGV no se cuenta dos veces", () => {
    const igv = `<cac:TaxTotal><cbc:TaxAmount currencyID="PEN">18.00</cbc:TaxAmount>${subtotal("1000", "100.00", "18.00")}</cac:TaxTotal>`;
    const r = leer(ubl({ final: igv }));
    // Un solo IGV de 18.00 sobre 100.00 (lo que dice el total 118.00), o rechazo: nunca 36.00 / 200.00.
    if (esDetalle(r)) {
      expect(r.totales.igv).toBe("18.00");
      expect(r.totales.gravado).toBe("100.00");
    } else {
      expect(r).toEqual(invalido);
    }
  });

  it("A5 · LegalMonetaryTotal o PayableAmount duplicados con valores distintos son ambiguos: xml_invalido", () => {
    const segundo = `<cac:LegalMonetaryTotal><cbc:PayableAmount currencyID="PEN">9999.00</cbc:PayableAmount></cac:LegalMonetaryTotal>`;
    expect(leer(ubl({ final: segundo }))).toEqual(invalido);
    expect(leer(ubl({ pagable: "118.00</cbc:PayableAmount><cbc:PayableAmount currencyID=\"PEN\">9999.00" }))).toEqual(invalido);
  });

  it("A6 · orden inverso, dos prefijos para el mismo espacio, espacio por defecto y currencyID ausente dan los mismos montos", () => {
    const original = ubl({ lineas: [linea({ descripcion: "orden" })] });
    const xml = original
      // LegalMonetaryTotal antes que TaxTotal.
      .replace(/(<cac:TaxTotal>.*?<\/cac:TaxTotal>)(<cac:LegalMonetaryTotal>.*?<\/cac:LegalMonetaryTotal>)/, "$2$1")
      // El IGV con otro prefijo ligado al mismo espacio de nombres y sin currencyID.
      .replace(
        '<cbc:TaxAmount currencyID="PEN">18.00</cbc:TaxAmount>',
        '<z:TaxAmount xmlns:z="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">18.00</z:TaxAmount>',
      )
      // El total con el espacio cbc como espacio por defecto.
      .replace(
        '<cbc:PayableAmount currencyID="PEN">118.00</cbc:PayableAmount>',
        '<PayableAmount xmlns="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" currencyID="PEN">118.00</PayableAmount>',
      );
    expect(xml.indexOf("<cac:LegalMonetaryTotal>")).toBeLessThan(xml.indexOf("<cac:TaxTotal>"));
    expect(xml).toContain("<z:TaxAmount");
    expect(xml).toContain("<PayableAmount xmlns=");
    const r = leer(xml);
    expect(esDetalle(r)).toBe(true);
    if (!esDetalle(r)) return;
    expect(r.totales).toMatchObject({ gravado: "100.00", igv: "18.00", total: "118.00" });
    expect(r.monedaUnica).toBe(true);
  });

  it("A7 · importes con sintaxis rara: notación científica, hex, coma, signo +, Infinity o dígitos no ASCII se rechazan; 0.005, 0.015, espacios y -0 se normalizan", () => {
    for (const raro of ["1e3", "1E+2", "0x10", "118,00", "+118.00", "Infinity", "NaN", "１１８.00", ".5", "5.", "1 18.00", "118.00-"]) {
      expect(leer(ubl({ pagable: raro, incluyeImpuestos: null })), raro).toEqual(invalido);
    }
    const total = (pagable: string): string | null => {
      const r = leer(ubl({ pagable, incluyeImpuestos: null }));
      return esDetalle(r) ? r.totales.total : null;
    };
    expect(total("0.005")).toBe("0.01");
    expect(total("0.015")).toBe("0.02");
    expect(total("\n  118.00\t ")).toBe("118.00");
    expect(total("-0")).toBe("0.00");
    expect(total("-0.00")).toBe("0.00");
    // En una nota de crédito un cero no sale como «-0.00».
    const nc = leer(ubl({ raiz: "CreditNote", subtotales: [subtotal("1000", "0.00", "0.00")], pagable: "0.00", incluyeImpuestos: null, lineas: [linea({ raiz: "CreditNote", valor: "0.00" })] }));
    expect(esDetalle(nc)).toBe(true);
    if (esDetalle(nc)) for (const v of Object.values(nc.totales)) expect(v).not.toBe("-0.00");
  });

  it("A8 · ítems en el tope exacto (2.000) con la profundidad máxima en cada línea se aceptan y el error de 2.001 no repite nada", () => {
    const hondo = `${"<x>".repeat(28)}${CANARIO}${"</x>".repeat(28)}`; // raíz + línea + Item + Description... cabe en 32
    const lineas = (n: number): string[] => Array.from({ length: n }, (_, i) => linea({ n: String(i + 1), descripcion: i === 0 ? `d${hondo}` : "d" }));
    const ok = leer(ubl({ lineas: lineas(2000) }));
    expect(esDetalle(ok) ? ok.items.length : ok).toBe(2000);
    expect(leer(ubl({ lineas: lineas(2001) }))).toEqual(invalido);
  });
});

// ---------------------------------------------------------------------------------------------------------- caja blanca
describe("T18 · caja blanca · leer.ts y escaneo.ts", () => {
  it("A9 · un Invoice con InvoiceTypeCode 07 (o fuera de 01/03) no se hace pasar por una nota de crédito con montos positivos", () => {
    // leer.ts: el tipo de un Invoice sale de InvoiceTypeCode sin restringirlo a 01/03, y el signo depende solo de la raíz.
    for (const tipo of ["07", "08", "99"]) {
      const r = leer(ubl({ tipo }));
      if (esDetalle(r)) {
        expect(["01", "03"], `Invoice con tipo ${tipo}`).toContain(r.identidad.tipo);
      } else {
        expect(r).toEqual(invalido);
      }
    }
  });

  it("A10 · una nota de crédito con importes ya negativos no sale en positivo (010 D6: la NC siempre en negativo)", () => {
    // montos.ts `texto` niega lo que venga; leer.ts acepta importes con signo en el XML.
    const r = leer(
      ubl({
        raiz: "CreditNote",
        subtotales: [subtotal("1000", "-100.00", "-18.00")],
        pagable: "-118.00",
        incluyeImpuestos: null,
        lineas: [linea({ raiz: "CreditNote", valor: "-100.00", precio: "100.00" })],
      }),
    );
    if (esDetalle(r)) {
      expect(r.totales.total.startsWith("-")).toBe(true);
      expect(r.totales.gravado.startsWith("-")).toBe(true);
      expect(r.totales.igv.startsWith("-")).toBe(true);
    } else {
      expect(r).toEqual(invalido);
    }
  });

  it("A11 · líneas autocerradas con atributos no burlan el tope de 2.000 ítems (P-5)", () => {
    // escaneo.ts solo cuenta etiquetas de apertura no autocerradas; leer.ts toma como línea todo nodo `InvoiceLine` con atributos.
    const reales = Array.from({ length: 2000 }, (_, i) => linea({ n: String(i + 1) }));
    const fantasmas = '<cac:InvoiceLine a="1"/>'.repeat(5000);
    const r = leer(ubl({ lineas: [...reales, fantasmas] }));
    if (esDetalle(r)) expect(r.items.length).toBeLessThanOrEqual(2000);
    else expect(r).toEqual(invalido);
  });
});

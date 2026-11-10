// Spec 016 · T19 · correcciones de la ronda adversarial 1 (H-016-1 a H-016-6) sobre el parser UBL (D-1, D-2, D-3; CA-1, CA-2, CA-5).
// Fijan el comportamiento correcto; las pruebas `ronda1.adv.spec.ts` de T18 siguen siendo las del ataque. Nacen en rojo (T20 corrige).
// Decisión común: un XML ambiguo o fuera de contrato es `xml_invalido`, nunca un valor elegido por el parser.
import { describe, expect, it } from "vitest";
import { linea, subtotal, ubl, utf8 } from "../../tests/ayudas/ubl";
import type { RaizUbl } from "../../tests/ayudas/ubl";
import { UblError, leerUbl } from "./index";

/** `xml_invalido` / `xml_incompleto` o el detalle; cualquier error que no sea `UblError` rompe la prueba. */
function resultado(entrada: string) {
  try {
    return { detalle: leerUbl(utf8(entrada)) };
  } catch (e) {
    expect(e).toBeInstanceOf(UblError);
    return { codigo: (e as UblError).codigo };
  }
}
const codigo = (entrada: string): string => {
  const r = resultado(entrada);
  return "codigo" in r ? r.codigo! : "aceptado";
};
const detalleDe = (entrada: string) => {
  const r = resultado(entrada);
  if (!("detalle" in r)) throw new Error(`se esperaba un detalle y salió ${r.codigo}`);
  return r.detalle!;
};

const LINEA_DE: Record<RaizUbl, string> = { Invoice: "InvoiceLine", CreditNote: "CreditNoteLine", DebitNote: "DebitNoteLine" };
const reales = (raiz: RaizUbl, n: number): string[] => Array.from({ length: n }, (_, i) => linea({ raiz, n: String(i + 1) }));
const ids = { Invoice: "F001-2056", CreditNote: "FC01-15", DebitNote: "FD01-3" } as const;

// ---------------------------------------------------------------------------------------------------------- H-016-1
describe("H-016-1 · el tope de 2.000 ítems cuenta toda línea, también la autocerrada (P-5)", () => {
  it.each(["Invoice", "CreditNote", "DebitNote"] as const)("%s: 2.001 líneas autocerradas, con o sin atributos, son xml_invalido", (raiz) => {
    const nombre = LINEA_DE[raiz];
    expect(codigo(ubl({ raiz, id: ids[raiz], lineas: Array.from({ length: 2001 }, () => `<cac:${nombre}/>`) })), "sin atributos").toBe("xml_invalido");
    expect(codigo(ubl({ raiz, id: ids[raiz], lineas: Array.from({ length: 2001 }, () => `<cac:${nombre} a="1"/>`) })), "con atributo").toBe("xml_invalido");
    expect(codigo(ubl({ raiz, id: ids[raiz], lineas: Array.from({ length: 2001 }, () => `<cac:${nombre} />`) })), "con espacio").toBe("xml_invalido");
  });

  it("2.000 líneas reales más una autocerrada superan el tope: xml_invalido", () => {
    expect(codigo(ubl({ lineas: [...reales("Invoice", 2000), "<cac:InvoiceLine/>"] }))).toBe("xml_invalido");
    expect(codigo(ubl({ lineas: [...reales("Invoice", 2000), '<cac:InvoiceLine a="1"/>'] }))).toBe("xml_invalido");
  });

  it("mezcla de reales y autocerradas que suma 2.001 es xml_invalido; el prefijo de espacio de nombres no cambia la cuenta", () => {
    expect(codigo(ubl({ lineas: [...reales("Invoice", 1000), ...Array.from({ length: 1001 }, () => "<cac:InvoiceLine/>")] }))).toBe("xml_invalido");
    const sinPrefijo = ubl({ lineas: Array.from({ length: 2001 }, () => "<InvoiceLine/>") });
    expect(codigo(sinPrefijo)).toBe("xml_invalido");
  });

  it("el tope sigue en 2.000: 2.000 líneas reales se aceptan", () => {
    expect(detalleDe(ubl({ lineas: reales("Invoice", 2000) })).items).toHaveLength(2000);
  });
});

// ---------------------------------------------------------------------------------------------------------- H-016-2
describe("H-016-2 · más de un TaxTotal hijo directo de la raíz es xml_invalido (D-2)", () => {
  const igv = `<cac:TaxTotal><cbc:TaxAmount currencyID="PEN">18.00</cbc:TaxAmount>${subtotal("1000", "100.00", "18.00")}</cac:TaxTotal>`;

  it.each(["Invoice", "CreditNote", "DebitNote"] as const)("%s: un segundo TaxTotal del documento, idéntico o distinto, antes o después de las líneas", (raiz) => {
    const comun = { raiz, id: ids[raiz], lineas: [linea({ raiz })] };
    expect(codigo(ubl({ ...comun, final: igv })), "idéntico, al final").toBe("xml_invalido");
    expect(codigo(ubl({ ...comun, extensiones: igv })), "idéntico, al principio").toBe("xml_invalido");
    const otro = `<cac:TaxTotal><cbc:TaxAmount currencyID="PEN">5.00</cbc:TaxAmount>${subtotal("2000", "100.00", "5.00")}</cac:TaxTotal>`;
    expect(codigo(ubl({ ...comun, final: otro })), "distinto").toBe("xml_invalido");
  });

  it("un TaxTotal vacío repetido a nivel documento también es ambiguo", () => {
    expect(codigo(ubl({ final: "<cac:TaxTotal/>" }))).toBe("xml_invalido");
  });

  it("los TaxTotal de cada línea siguen permitidos y no cambian los totales del documento", () => {
    const lineas = [
      linea({ n: "1", valor: "50.00", precio: "50.00", subtotales: [subtotal("1000", "50.00", "9.00")] }),
      linea({ n: "2", valor: "50.00", precio: "50.00", subtotales: [subtotal("1000", "50.00", "9.00")] }),
    ];
    const d = detalleDe(ubl({ lineas }));
    expect(d.items).toHaveLength(2);
    expect(d.items.map((i) => i.igv)).toEqual(["9.00", "9.00"]);
    expect(d.totales).toMatchObject({ gravado: "100.00", igv: "18.00", total: "118.00" });
  });
});

// ---------------------------------------------------------------------------------------------------------- H-016-3
describe("H-016-3 · la raíz y el tipo de comprobante tienen que casar (D-2)", () => {
  it.each(["07", "08", "99", "02", "09"])("Invoice con InvoiceTypeCode %s es xml_invalido", (tipo) => {
    expect(codigo(ubl({ tipo }))).toBe("xml_invalido");
  });

  it("Invoice con 01 y 03 se aceptan; CreditNote es 07 y DebitNote es 08", () => {
    expect(detalleDe(ubl({ tipo: "01" })).identidad.tipo).toBe("01");
    expect(detalleDe(ubl({ tipo: "03", id: "B001-291" })).identidad.tipo).toBe("03");
    expect(detalleDe(ubl({ raiz: "CreditNote", id: ids.CreditNote, lineas: [linea({ raiz: "CreditNote" })] })).identidad.tipo).toBe("07");
    expect(detalleDe(ubl({ raiz: "DebitNote", id: ids.DebitNote, lineas: [linea({ raiz: "DebitNote" })] })).identidad.tipo).toBe("08");
  });
});

// ---------------------------------------------------------------------------------------------------------- H-016-4
describe("H-016-4 · un importe negativo en el XML es xml_invalido en cualquier raíz; el signo de la NC lo pone el mapeo (D-2)", () => {
  const negativos: [string, (raiz: RaizUbl) => string][] = [
    ["total (PayableAmount)", (raiz) => ubl({ raiz, id: ids[raiz], pagable: "-118.00", incluyeImpuestos: null, lineas: [linea({ raiz })] })],
    ["total con impuestos (TaxInclusiveAmount)", (raiz) => ubl({ raiz, id: ids[raiz], incluyeImpuestos: "-118.00", lineas: [linea({ raiz })] })],
    ["TaxAmount del subtotal", (raiz) => ubl({ raiz, id: ids[raiz], subtotales: [subtotal("1000", "100.00", "-18.00")], lineas: [linea({ raiz })] })],
    ["TaxableAmount del subtotal", (raiz) => ubl({ raiz, id: ids[raiz], subtotales: [subtotal("1000", "-100.00", "18.00")], lineas: [linea({ raiz })] })],
    ["valor de la línea (LineExtensionAmount)", (raiz) => ubl({ raiz, id: ids[raiz], lineas: [linea({ raiz, valor: "-100.00" })] })],
    ["precio unitario de la línea", (raiz) => ubl({ raiz, id: ids[raiz], lineas: [linea({ raiz, precio: "-100.00" })] })],
    ["impuesto de la línea", (raiz) => ubl({ raiz, id: ids[raiz], lineas: [linea({ raiz, subtotales: [subtotal("1000", "100.00", "-18.00")] })] })],
  ];

  for (const raiz of ["Invoice", "CreditNote", "DebitNote"] as const) {
    it.each(negativos)(`${raiz}: ${"%s"} negativo`, (_campo, armar) => {
      expect(codigo(armar(raiz))).toBe("xml_invalido");
    });
  }

  it("la nota de crédito con importes positivos sale en negativo (el signo lo pone solo el mapeo)", () => {
    const d = detalleDe(ubl({ raiz: "CreditNote", id: ids.CreditNote, lineas: [linea({ raiz: "CreditNote" })] }));
    expect(d.totales).toMatchObject({ gravado: "-100.00", igv: "-18.00", total: "-118.00" });
  });

  it("cero con signo («-0», «-0.00») no es negativo y se normaliza a 0.00 (T18 A7)", () => {
    for (const cero of ["-0", "-0.00"]) {
      expect(detalleDe(ubl({ pagable: cero, incluyeImpuestos: null })).totales.total, cero).toBe("0.00");
    }
  });
});

// ---------------------------------------------------------------------------------------------------------- H-016-5
describe("H-016-5 · LegalMonetaryTotal o PayableAmount duplicado a nivel documento es xml_invalido (D-2)", () => {
  const total = (valor: string) => `<cac:LegalMonetaryTotal><cbc:PayableAmount currencyID="PEN">${valor}</cbc:PayableAmount></cac:LegalMonetaryTotal>`;

  it("un segundo LegalMonetaryTotal, con otro valor o con el mismo", () => {
    expect(codigo(ubl({ final: total("9999.00") })), "otro valor").toBe("xml_invalido");
    expect(codigo(ubl({ final: total("118.00") })), "mismo valor").toBe("xml_invalido");
    expect(codigo(ubl({ extensiones: total("9999.00") })), "antes del primero").toBe("xml_invalido");
  });

  it("dos PayableAmount dentro del mismo LegalMonetaryTotal, con otro valor o con el mismo", () => {
    expect(codigo(ubl({ pagable: '118.00</cbc:PayableAmount><cbc:PayableAmount currencyID="PEN">9999.00' })), "otro valor").toBe("xml_invalido");
    expect(codigo(ubl({ pagable: '118.00</cbc:PayableAmount><cbc:PayableAmount currencyID="PEN">118.00' })), "mismo valor").toBe("xml_invalido");
  });

  it("nota de débito: dos RequestedMonetaryTotal, o uno de cada clase, son ambiguos", () => {
    const base = ubl({ raiz: "DebitNote", id: ids.DebitNote, lineas: [linea({ raiz: "DebitNote" })] }).replace(/LegalMonetaryTotal/g, "RequestedMonetaryTotal");
    const segundo = `<cac:RequestedMonetaryTotal><cbc:PayableAmount currencyID="PEN">9999.00</cbc:PayableAmount></cac:RequestedMonetaryTotal>`;
    expect(codigo(base.replace("</DebitNote>", `${segundo}</DebitNote>`)), "dos Requested").toBe("xml_invalido");
    expect(codigo(base.replace("</DebitNote>", `${total("9999.00")}</DebitNote>`)), "Requested y Legal").toBe("xml_invalido");
  });

  it("un solo total sigue leyéndose", () => {
    expect(detalleDe(ubl()).totales.total).toBe("118.00");
  });
});

// ---------------------------------------------------------------------------------------------------------- H-016-6
describe("H-016-6 · solo una declaración de codificación limpia y admitida se acepta (D-1)", () => {
  const engañosas: [string, string][] = [
    ["encoding repetido (UTF-8 y luego UTF-16)", '<?xml version="1.0" encoding="UTF-8" encoding="UTF-16"?>\n'],
    ["encoding repetido (UTF-16 y luego UTF-8)", '<?xml version="1.0" encoding="UTF-16" encoding="UTF-8"?>\n'],
    ["encoding repetido con el mismo valor", '<?xml version="1.0" encoding="UTF-8" encoding="UTF-8"?>\n'],
    ["atributo con guion que termina en encoding", '<?xml version="1.0" x-encoding="UTF-8" encoding="UTF-16"?>\n'],
    ["atributo con guion antes del válido", '<?xml version="1.0" x-encoding="UTF-16" encoding="UTF-8"?>\n'],
    ["atributo con prefijo", '<?xml version="1.0" x:encoding="UTF-8"?>\n'],
    ["atributo con prefijo antes del válido", '<?xml version="1.0" x:encoding="UTF-16" encoding="UTF-8"?>\n'],
    ["espacio al inicio del nombre", '<?xml version="1.0" encoding=" UTF-8"?>\n'],
    ["espacio al final del nombre", '<?xml version="1.0" encoding="UTF-8 "?>\n'],
    ["espacio dentro del nombre", '<?xml version="1.0" encoding="UTF- 8"?>\n'],
    ["comilla sin cerrar", '<?xml version="1.0" encoding="UTF-8?>\n'],
    ["comillas distintas", '<?xml version="1.0" encoding="UTF-8\'?>\n'],
    ["sin comillas", '<?xml version="1.0" encoding=UTF-8?>\n'],
    ["valor vacío", '<?xml version="1.0" encoding=""?>\n'],
  ];
  it.each(engañosas)("%s", (_nombre, declaracion) => {
    expect(codigo(ubl({ declaracion }))).toBe("xml_invalido");
  });

  it("las declaraciones limpias de siempre se aceptan (UTF-8, utf-8, ISO-8859-1, comillas simples, sin encoding)", () => {
    for (const d of [
      '<?xml version="1.0" encoding="UTF-8"?>\n',
      '<?xml version="1.0" encoding="utf-8"?>\n',
      "<?xml version='1.0' encoding='UTF-8'?>\n",
      '<?xml version="1.0" encoding="ISO-8859-1"?>\n',
      '<?xml version="1.0"?>\n',
    ]) {
      expect(codigo(ubl({ declaracion: d })), d).toBe("aceptado");
    }
  });
});

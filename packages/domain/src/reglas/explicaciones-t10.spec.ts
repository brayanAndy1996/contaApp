// T10 (backend): huecos del catálogo que T9 dejó abiertos (pendiente de revisión del arquitecto).
import { describe, expect, it } from "vitest";
import { ctx, evaluar, fila, montos, pen, PROVEEDOR, unico, xml } from "../../tests/ayudas/filas-motor";

describe("catálogo: casos cerrados en T10", () => {
  it("proveedor emisor de ISC con XML de ISC 0: dice el ISC del XML, sin sugerencia", () => {
    const c = ctx({ proveedoresIsc: [{ ...PROVEEDOR }] });
    const h = unico(evaluar([fila({ xml: xml() })], c).hallazgos, "R-ISC");
    expect(h.explicacion).toBe("Proveedor emisor de ISC: el XML indica ISC 0.00");
    expect(h.sugerencia).toBeNull();
    expect(h.requiereConfirmacion).toBe(true);
  });

  it("proveedor emisor de ISC sin XML: pide revisar con el XML", () => {
    const c = ctx({ proveedoresIsc: [{ ...PROVEEDOR }] });
    expect(unico(evaluar([fila()], c).hallazgos, "R-ISC").explicacion).toBe("Proveedor emisor de ISC: revisar con el XML");
  });

  it("R-MIX con XML y varios destinos con BI ≠ 0: sufijo fijo, sin exacto", () => {
    const m = montos("PEN", { biDg: "21.48", igvDg: "1.61", biDgng: "50.00", igvDgng: "9.00", total: "82.09" });
    const x = xml({ gravado: pen("58.97"), igv: pen("10.61"), noGravado: pen("12.51"), total: pen("82.09") });
    const h = unico(evaluar([fila({ montos: m, xml: x })]).hallazgos, "R-MIX");
    expect(h.explicacion).toBe("1.61 no es 18 % ni 10 % de 21.48; el XML no separa por destino: confirma el monto");
    expect(h.dato).toBe("gravado");
  });

  it("R-NEW y R-GP: textos del catálogo", () => {
    const f = fila({ xml: xml({ glosas: ["perfumes"] }) });
    const r = evaluar([f], ctx({ proveedoresConocidos: [] })).hallazgos;
    expect(unico(r, "R-NEW").explicacion).toBe("Proveedor nuevo: elige la clasificación");
    expect(unico(r, "R-GP").explicacion).toBe('Posible gasto personal: la glosa dice "perfume"');
  });
});

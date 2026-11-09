// Spec 016 · T2 (rojo). `aResumenXml(detalle) → ResumenXml` (011, `reglas/tipos.ts`): lo que las reglas leen del XML.
// Montos como `Money` en la moneda del documento; si `monedaUnica` es false, alguno queda en otra moneda para que 011 emita
// `XML_MONEDA` (D-2, D-6). Las notas de crédito salen en negativo (010 D6).
import { describe, expect, it } from "vitest";
import { Money } from "../dinero/index";
import { FIXTURES, detalleMixta, detalleSanJuan, ubl, linea, subtotal, utf8 } from "../../tests/ayudas/ubl";
import { aResumenXml, leerUbl } from "./index";

const montos = (r: ReturnType<typeof aResumenXml>) => [r.gravado, r.igv, r.noGravado, r.isc, r.icbper, r.total];

describe("aResumenXml", () => {
  it("F001-2056: identidad del proveedor y del comprobante, montos Money y glosas", () => {
    const r = aResumenXml(detalleMixta());
    expect(r.proveedor).toEqual({ tipo: "6", numero: "20700000045" });
    expect(r.comprobante).toEqual({ tipo: "01", serie: "F001", numero: "2056" });
    expect(r.moneda).toBe("PEN");
    expect(montos(r).every((m) => m instanceof Money)).toBe(true);
    expect(r.gravado.toString()).toBe("8.97");
    expect(r.igv.toString()).toBe("1.61");
    expect(r.noGravado.toString()).toBe("12.51");
    expect(r.isc.toString()).toBe("0.00");
    expect(r.icbper.toString()).toBe("0.00");
    expect(r.total.toString()).toBe("23.09");
    expect(r.glosas).toEqual(["Producto gravado de prueba (PRUEBA)", "Producto exonerado de prueba (PRUEBA)"]);
  });

  it("San Juan: ISC 770.00 y gravado 0.00", () => {
    const r = aResumenXml(detalleSanJuan());
    expect(r.gravado.toString()).toBe("0.00");
    expect(r.isc.toString()).toBe("770.00");
    expect(r.total.toString()).toBe("770.00");
  });

  it("XML en USD: todos los montos en USD (se compara sin convertir)", () => {
    const r = aResumenXml(leerUbl(utf8(FIXTURES.usd)));
    expect(r.moneda).toBe("USD");
    expect(montos(r).every((m) => m.moneda === "USD")).toBe(true);
    expect(r.total.toString()).toBe("0.18");
  });

  it("monedaUnica = false: algún monto queda en una moneda distinta de la del documento", () => {
    const r = aResumenXml(detalleMixta({ monedaUnica: false }));
    expect(r.moneda).toBe("PEN");
    expect(montos(r).some((m) => m.moneda !== r.moneda)).toBe(true);
  });

  it("monedaUnica = true: ningún monto cambia de moneda", () => {
    const r = aResumenXml(detalleMixta());
    expect(montos(r).every((m) => m.moneda === r.moneda)).toBe(true);
  });

  it("nota de crédito: los montos del resumen salen en negativo", () => {
    const d = leerUbl(utf8(ubl({ raiz: "CreditNote", id: "FC01-7", lineas: [linea({ raiz: "CreditNote" })] })));
    const r = aResumenXml(d);
    expect(r.comprobante).toEqual({ tipo: "07", serie: "FC01", numero: "7" });
    expect(r.gravado.toString()).toBe("-100.00");
    expect(r.igv.toString()).toBe("-18.00");
    expect(r.total.toString()).toBe("-118.00");
  });

  it("de punta a punta: sin ceros a la izquierda y con el redondeo de SUNAT", () => {
    const d = leerUbl(utf8(ubl({ id: "F001-00002056", subtotales: [subtotal("1000", "8.965", "1.61")], pagable: "10.575", incluyeImpuestos: "10.575" })));
    const r = aResumenXml(d);
    expect(r.comprobante.numero).toBe("2056");
    expect(r.gravado.toString()).toBe("8.97");
    expect(r.total.toString()).toBe("10.58");
  });

  it("es pura: el mismo detalle da el mismo resumen y no lo muta", () => {
    const d = detalleMixta();
    const antes = JSON.stringify(d);
    expect(aResumenXml(d).total.toString()).toBe(aResumenXml(d).total.toString());
    expect(JSON.stringify(d)).toBe(antes);
  });
});

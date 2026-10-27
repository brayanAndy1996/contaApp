// Casos reales de los videos (docs/01-definiciones-base.md §7 puntos 9 y 10; spec 010).
import { describe, expect, it } from "vitest";
import { MontosComprobante, moverMonto } from "../../src/comprobante/index";
import {
  igvCuadra, igvEsperado, Money, TASA_IGV_10, TASA_IGV_18, Tolerancia, verificarCuadre,
} from "../../src/dinero/index";

const pen = (s: string): Money => Money.desde(s, "PEN");
const tol0 = (): Tolerancia => Tolerancia.desde("0.00");

describe("caso real: factura mixta base 21.48 / IGV 1.61", () => {
  it("no cuadra a 18 % (esperado 3.87) ni a 10 % (esperado 2.15)", () => {
    expect(igvEsperado(pen("21.48"), TASA_IGV_18).toString()).toBe("3.87");
    expect(igvEsperado(pen("21.48"), TASA_IGV_10).toString()).toBe("2.15");
    expect(igvCuadra(pen("21.48"), pen("1.61"), TASA_IGV_18)).toBe(false);
    expect(igvCuadra(pen("21.48"), pen("1.61"), TASA_IGV_10)).toBe(false);
  });

  it("cualquier gravado entre 8.92 y 8.97 produce IGV 1.61; 8.91 da 1.60 y 8.98 da 1.62", () => {
    for (const g of ["8.92", "8.93", "8.94", "8.95", "8.96", "8.97"]) {
      expect(igvEsperado(pen(g), TASA_IGV_18).toString()).toBe("1.61");
    }
    expect(igvEsperado(pen("8.91"), TASA_IGV_18).toString()).toBe("1.60");
    expect(igvEsperado(pen("8.98"), TASA_IGV_18).toString()).toBe("1.62");
  });

  it("con el gravado real del XML (8.97) el IGV 1.61 sí cuadra a 18 %", () => {
    expect(igvCuadra(pen("8.97"), pen("1.61"), TASA_IGV_18)).toBe(true);
  });

  it("moverMonto de BI DG a no gravado 12.51 deja 8.97 + 12.51 con el total igual", () => {
    const m = MontosComprobante.desde("PEN", { biDg: "21.48", igvDg: "1.61", total: "23.09" });
    const r = moverMonto(m, "biDg", "noGravado", pen("12.51"));
    expect(r.obtener("biDg").toString()).toBe("8.97");
    expect(r.obtener("noGravado").toString()).toBe("12.51");
    expect(r.obtener("igvDg").toString()).toBe("1.61");
    expect(r.total.toString()).toBe("23.09");
    expect(verificarCuadre(r, tol0()).cuadra).toBe(true);
    expect(igvCuadra(r.obtener("biDg"), r.obtener("igvDg"), TASA_IGV_18)).toBe(true);
  });
});

describe("caso real: Cervecería San Juan, ISC enviado a DG (BI DG 770.00, IGV DG 0.00)", () => {
  const m = MontosComprobante.desde("PEN", { biDg: "770.00", igvDg: "0.00", total: "770.00" });

  it("antes de corregir, la base gravada con IGV 0.00 no cuadra con ninguna tasa", () => {
    expect(igvCuadra(pen("770.00"), pen("0.00"), TASA_IGV_18)).toBe(false);
    expect(igvCuadra(pen("770.00"), pen("0.00"), TASA_IGV_10)).toBe(false);
  });

  it("mover 770.00 de BI DG a ISC conserva el total y deja IGV DG en 0.00", () => {
    const r = moverMonto(m, "biDg", "isc", pen("770.00"));
    expect(r.obtener("isc").toString()).toBe("770.00");
    expect(r.obtener("biDg").toString()).toBe("0.00");
    expect(r.obtener("igvDg").toString()).toBe("0.00");
    expect(r.total.toString()).toBe("770.00");
    expect(verificarCuadre(r, tol0()).cuadra).toBe(true);
  });

  it("el comprobante original no se modifica", () => {
    const antes = JSON.stringify(m);
    moverMonto(m, "biDg", "isc", pen("770.00"));
    expect(JSON.stringify(m)).toBe(antes);
  });
});

describe("caso real: redondeo en facturas en dólares", () => {
  it.todo("redondeo USD: caso real diferido, sin cifras");
});

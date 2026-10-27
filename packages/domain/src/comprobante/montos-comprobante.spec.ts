import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  arbFila, centavosAString, COLS, NUM_RUNS, SEMILLA, totalCentavos, valores,
} from "../../tests/ayudas/comprobante";
import {
  Money, MonedaDistintaError, MontoInvalidoError, Tolerancia, verificarCuadre,
} from "../dinero/index";
import { COLUMNAS_COMPRA } from "./columnas";
import { MontosComprobante } from "./montos-comprobante";

const tol0 = (): Tolerancia => Tolerancia.desde("0.00");

describe("COLUMNAS_COMPRA", () => {
  it("tiene las 10 columnas de compras en el orden del plan (D4)", () => {
    expect(COLUMNAS_COMPRA).toEqual([
      "biDg", "igvDg", "biDgng", "igvDgng", "biDng", "igvDng",
      "noGravado", "isc", "icbper", "otrosTributos",
    ]);
  });
});

describe("MontosComprobante.desde / obtener", () => {
  it("columna faltante vale 0.00 y las dadas se conservan", () => {
    const m = MontosComprobante.desde("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.00" });
    expect(m.moneda).toBe("PEN");
    expect(m.total.toString()).toBe("118.00");
    expect(m.obtener("biDg").toString()).toBe("100.00");
    expect(m.obtener("igvDg").toString()).toBe("18.00");
    expect(m.obtener("biDng").toString()).toBe("0.00");
    expect(m.obtener("isc").toString()).toBe("0.00");
    expect(m.obtener("otrosTributos").toString()).toBe("0.00");
  });

  it("las columnas son Money en la moneda del comprobante", () => {
    const m = MontosComprobante.desde("USD", { biDg: "1.00", total: "1.00" });
    expect(m.obtener("biDg")).toBeInstanceOf(Money);
    expect(m.obtener("biDg").moneda).toBe("USD");
    expect(m.total.moneda).toBe("USD");
  });

  it("clave desconocida lanza MontoInvalidoError", () => {
    expect(() =>
      MontosComprobante.desde("PEN", { biDg: "1.00", total: "1.00", bi_dg: "1.00" } as never),
    ).toThrow(MontoInvalidoError);
    expect(() =>
      MontosComprobante.desde("PEN", { total: "1.00", constructor: "1.00" } as never),
    ).toThrow(MontoInvalidoError);
  });

  it("un valor que no es string (number) lanza MontoInvalidoError", () => {
    expect(() =>
      MontosComprobante.desde("PEN", { biDg: 12.5 as unknown as string, total: "12.50" }),
    ).toThrow(MontoInvalidoError);
    expect(() =>
      MontosComprobante.desde("PEN", { total: 0 as unknown as string }),
    ).toThrow(MontoInvalidoError);
  });

  it("un monto con más de 2 decimales o formato local lanza MontoInvalidoError", () => {
    expect(() => MontosComprobante.desde("PEN", { biDg: "1.005", total: "1.00" })).toThrow(MontoInvalidoError);
    expect(() => MontosComprobante.desde("PEN", { biDg: "1,00", total: "1.00" })).toThrow(MontoInvalidoError);
  });

  it("es inmutable: el objeto y componentes() están congelados", () => {
    const m = MontosComprobante.desde("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.00" });
    expect(Object.isFrozen(m)).toBe(true);
    const comps = m.componentes();
    expect(Object.isFrozen(comps)).toBe(true);
    // un arreglo nuevo en cada llamada
    expect(m.componentes()).not.toBe(comps);
  });

  it("componentes() devuelve las 10 columnas en el orden de COLUMNAS_COMPRA", () => {
    const m = MontosComprobante.desde("PEN", {
      biDg: "1.00", igvDg: "2.00", biDgng: "3.00", igvDgng: "4.00", biDng: "5.00",
      igvDng: "6.00", noGravado: "7.00", isc: "8.00", icbper: "9.00", otrosTributos: "10.00",
      total: "55.00",
    });
    expect(m.componentes().map((x) => x.toString())).toEqual([
      "1.00", "2.00", "3.00", "4.00", "5.00", "6.00", "7.00", "8.00", "9.00", "10.00",
    ]);
  });
});

describe("MontosComprobante.sumar", () => {
  it("suma por columna y el total", () => {
    const a = MontosComprobante.desde("PEN", { biDg: "100.00", igvDg: "18.00", isc: "5.00", total: "123.00" });
    const b = MontosComprobante.desde("PEN", { biDg: "50.50", igvDng: "9.09", noGravado: "1.00", total: "60.59" });
    const s = a.sumar(b);
    expect(s.obtener("biDg").toString()).toBe("150.50");
    expect(s.obtener("igvDg").toString()).toBe("18.00");
    expect(s.obtener("igvDng").toString()).toBe("9.09");
    expect(s.obtener("isc").toString()).toBe("5.00");
    expect(s.obtener("noGravado").toString()).toBe("1.00");
    expect(s.obtener("biDgng").toString()).toBe("0.00");
    expect(s.total.toString()).toBe("183.59");
    expect(s.moneda).toBe("PEN");
  });

  it("no muta ninguno de los operandos y el resultado está congelado", () => {
    const a = MontosComprobante.desde("PEN", { biDg: "1.00", total: "1.00" });
    const b = MontosComprobante.desde("PEN", { biDg: "2.00", total: "2.00" });
    const antesA = JSON.stringify(a);
    const antesB = JSON.stringify(b);
    const s = a.sumar(b);
    expect(JSON.stringify(a)).toBe(antesA);
    expect(JSON.stringify(b)).toBe(antesB);
    expect(Object.isFrozen(s)).toBe(true);
  });

  it("CA-7: PEN + USD lanza MonedaDistintaError (en ambos sentidos)", () => {
    const pen = MontosComprobante.desde("PEN", { biDg: "1.00", total: "1.00" });
    const usd = MontosComprobante.desde("USD", { biDg: "1.00", total: "1.00" });
    expect(() => pen.sumar(usd)).toThrow(MonedaDistintaError);
    expect(() => usd.sumar(pen)).toThrow(MonedaDistintaError);
  });

  it("USD + USD funciona y conserva la moneda", () => {
    const a = MontosComprobante.desde("USD", { biDg: "0.10", total: "0.10" });
    const b = MontosComprobante.desde("USD", { biDg: "0.20", total: "0.20" });
    const s = a.sumar(b);
    expect(s.moneda).toBe("USD");
    expect(s.obtener("biDg").toString()).toBe("0.30");
    expect(s.total.toString()).toBe("0.30");
  });

  it("suma de notas de crédito (negativas) y con facturas", () => {
    const f = MontosComprobante.desde("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.00" });
    const nc = MontosComprobante.desde("PEN", { biDg: "-100.00", igvDg: "-18.00", total: "-118.00" });
    const s = f.sumar(nc);
    expect(s.obtener("biDg").toString()).toBe("0.00");
    expect(s.obtener("igvDg").toString()).toBe("0.00");
    expect(s.total.toString()).toBe("0.00");
    expect(s.total.esCero()).toBe(true);
  });

  it("propiedad: sumar es conmutativo, coincide con el oráculo en enteros y cuadra (semilla fija)", () => {
    fc.assert(
      fc.property(arbFila(), arbFila(), (fa, fb) => {
        const a = MontosComprobante.desde("PEN", valores(fa) as never);
        const b = MontosComprobante.desde("PEN", valores(fb) as never);
        const ab = a.sumar(b);
        expect(JSON.stringify(ab)).toBe(JSON.stringify(b.sumar(a)));
        for (const c of COLS) expect(ab.obtener(c).toString()).toBe(centavosAString(fa[c] + fb[c]));
        expect(ab.total.toString()).toBe(centavosAString(totalCentavos(fa) + totalCentavos(fb)));
        expect(verificarCuadre(ab, tol0()).cuadra).toBe(true);
      }),
      { seed: SEMILLA, numRuns: NUM_RUNS },
    );
  });
});

describe("verificarCuadre sobre MontosComprobante (CA-10, D2)", () => {
  it("total = Σ columnas: cuadra con diferencia 0.00", () => {
    const m = MontosComprobante.desde("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.00" });
    const r = verificarCuadre(m, tol0());
    expect(r.cuadra).toBe(true);
    expect(r.sumaComponentes.toString()).toBe("118.00");
    expect(r.total.toString()).toBe("118.00");
    expect(r.diferencia.toString()).toBe("0.00");
  });

  it("CA-10: total 0.01 por encima de la suma no cuadra y diferencia = total - suma = 0.01", () => {
    const m = MontosComprobante.desde("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.01" });
    const r = verificarCuadre(m, tol0());
    expect(r.cuadra).toBe(false);
    expect(r.sumaComponentes.toString()).toBe("118.00");
    expect(r.total.toString()).toBe("118.01");
    expect(r.diferencia.toString()).toBe("0.01");
  });

  it("CA-10: total 0.01 por debajo de la suma no cuadra y diferencia = -0.01", () => {
    const m = MontosComprobante.desde("PEN", { biDg: "100.00", igvDg: "18.00", total: "117.99" });
    const r = verificarCuadre(m, tol0());
    expect(r.cuadra).toBe(false);
    expect(r.diferencia.toString()).toBe("-0.01");
  });

  it("con tolerancia 0.01 una diferencia de 0.01 sí cuadra y una de 0.02 no", () => {
    const tol1 = Tolerancia.desde("0.01");
    const a = MontosComprobante.desde("PEN", { biDg: "100.00", total: "100.01" });
    const b = MontosComprobante.desde("PEN", { biDg: "100.00", total: "100.02" });
    expect(verificarCuadre(a, tol1).cuadra).toBe(true);
    expect(verificarCuadre(b, tol1).cuadra).toBe(false);
    expect(verificarCuadre(b, tol1).diferencia.toString()).toBe("0.02");
  });

  it("suma todas las columnas (ISC, ICBPER, otros tributos, no gravado)", () => {
    const m = MontosComprobante.desde("PEN", {
      biDg: "10.00", igvDg: "1.80", noGravado: "2.00", isc: "3.00", icbper: "0.50",
      otrosTributos: "0.25", total: "17.55",
    });
    expect(verificarCuadre(m, tol0()).cuadra).toBe(true);
    const sinIsc = MontosComprobante.desde("PEN", {
      biDg: "10.00", igvDg: "1.80", noGravado: "2.00", icbper: "0.50", otrosTributos: "0.25", total: "17.55",
    });
    expect(verificarCuadre(sinIsc, tol0()).diferencia.toString()).toBe("3.00");
  });

  it("nota de crédito (todo negativo) cuadra y un total con signo equivocado no se oculta", () => {
    const nc = MontosComprobante.desde("PEN", { biDg: "-100.00", igvDg: "-18.00", total: "-118.00" });
    expect(verificarCuadre(nc, tol0()).cuadra).toBe(true);
    const mal = MontosComprobante.desde("PEN", { biDg: "-100.00", igvDg: "-18.00", total: "118.00" });
    const r = verificarCuadre(mal, tol0());
    expect(r.cuadra).toBe(false);
    expect(r.diferencia.toString()).toBe("236.00");
  });

  it("un comprobante en USD cuadra en su moneda", () => {
    const m = MontosComprobante.desde("USD", { biDg: "0.15", igvDg: "0.03", total: "0.18" });
    const r = verificarCuadre(m, tol0());
    expect(r.cuadra).toBe(true);
    expect(r.total.moneda).toBe("USD");
  });
});

describe("MontosComprobante.toJSON", () => {
  it("devuelve moneda, total y las 10 columnas como strings (sin number)", () => {
    const m = MontosComprobante.desde("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.00" });
    const j = m.toJSON();
    expect(j.moneda).toBe("PEN");
    expect(j.total).toBe("118.00");
    expect(Object.keys(j.columnas)).toEqual([
      "biDg", "igvDg", "biDgng", "igvDgng", "biDng", "igvDng",
      "noGravado", "isc", "icbper", "otrosTributos",
    ]);
    expect(j.columnas.biDg).toBe("100.00");
    expect(j.columnas.biDng).toBe("0.00");
  });

  it("JSON.stringify no produce ningún number y la ida y vuelta es idéntica", () => {
    const m = MontosComprobante.desde("USD", { biDg: "0.15", igvDg: "0.03", total: "0.18" });
    const txt = JSON.stringify(m);
    const tipos: string[] = [];
    JSON.parse(txt, (_k, v) => {
      tipos.push(typeof v);
      return v;
    });
    expect(tipos).not.toContain("number");
    const j = JSON.parse(txt) as { moneda: "USD"; total: string; columnas: Record<string, string> };
    const m2 = MontosComprobante.desde(j.moneda, { ...j.columnas, total: j.total });
    expect(JSON.stringify(m2)).toBe(txt);
  });
});

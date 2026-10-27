import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  arbFila, centavosAString, COLS, NUM_RUNS, SEMILLA, valores,
} from "../../tests/ayudas/comprobante";
import {
  ComprobanteDescuadradoError, DineroError, MontoFueraDeRangoError, TipoCambio, Tolerancia, verificarCuadre,
} from "../dinero/index";
import { convertirAPen } from "./convertir";
import { MontosComprobante } from "./montos-comprobante";

const tol0 = (): Tolerancia => Tolerancia.desde("0.00");

describe("TipoCambio (D7): rechazos usados por la conversión", () => {
  it("más de 3 decimales, cero y negativo se rechazan", () => {
    expect(() => TipoCambio.desde("3.3001")).toThrow(DineroError);
    expect(() => TipoCambio.desde("0")).toThrow(DineroError);
    expect(() => TipoCambio.desde("0.000")).toThrow(DineroError);
    expect(() => TipoCambio.desde("-3.300")).toThrow(DineroError);
  });

  it("3 decimales o menos se aceptan", () => {
    expect(() => TipoCambio.desde("3.300")).not.toThrow();
    expect(() => TipoCambio.desde("3.3")).not.toThrow();
    expect(() => TipoCambio.desde("4")).not.toThrow();
  });
});

describe("convertirAPen", () => {
  it("CA-13: BI 0.15, IGV 0.03, total 0.18 a TC 3.300 -> 0.50, 0.10 y total 0.60 (no 0.59) y cuadra", () => {
    const usd = MontosComprobante.desde("USD", { biDg: "0.15", igvDg: "0.03", total: "0.18" });
    const pen = convertirAPen(usd, TipoCambio.desde("3.300"));
    expect(pen.moneda).toBe("PEN");
    expect(pen.obtener("biDg").toString()).toBe("0.50"); // 0.495 -> half-up
    expect(pen.obtener("igvDg").toString()).toBe("0.10"); // 0.099
    expect(pen.total.toString()).toBe("0.60"); // suma de convertidos
    expect(pen.total.toString()).not.toBe("0.59"); // redondeo de 0.18 x 3.300 = 0.594
    expect(pen.obtener("biDg").moneda).toBe("PEN");
    expect(pen.total.moneda).toBe("PEN");
    const c = verificarCuadre(pen, tol0());
    expect(c.cuadra).toBe(true);
    expect(c.diferencia.toString()).toBe("0.00");
  });

  it("cada columna se redondea por separado y las vacías quedan en 0.00", () => {
    const usd = MontosComprobante.desde("USD", {
      biDg: "10.00", igvDg: "1.80", noGravado: "2.01", isc: "0.01", icbper: "0.05", total: "13.87",
    });
    const pen = convertirAPen(usd, TipoCambio.desde("3.745"));
    expect(pen.obtener("biDg").toString()).toBe("37.45"); // 37.450
    expect(pen.obtener("igvDg").toString()).toBe("6.74"); // 6.741
    expect(pen.obtener("noGravado").toString()).toBe("7.53"); // 7.52745
    expect(pen.obtener("isc").toString()).toBe("0.04"); // 0.03745
    expect(pen.obtener("icbper").toString()).toBe("0.19"); // 0.18725
    expect(pen.obtener("biDng").toString()).toBe("0.00");
    expect(pen.obtener("otrosTributos").toString()).toBe("0.00");
    // total = suma de los convertidos: 37.45 + 6.74 + 7.53 + 0.04 + 0.19
    expect(pen.total.toString()).toBe("51.95");
    expect(verificarCuadre(pen, tol0()).cuadra).toBe(true);
  });

  it("nota de crédito: el medio centavo se aleja de cero (-0.495 -> -0.50)", () => {
    const usd = MontosComprobante.desde("USD", { biDg: "-0.15", igvDg: "-0.03", total: "-0.18" });
    const pen = convertirAPen(usd, TipoCambio.desde("3.300"));
    expect(pen.obtener("biDg").toString()).toBe("-0.50");
    expect(pen.obtener("igvDg").toString()).toBe("-0.10");
    expect(pen.total.toString()).toBe("-0.60");
    expect(verificarCuadre(pen, tol0()).cuadra).toBe(true);
  });

  it("el original USD no cambia y el resultado está congelado", () => {
    const usd = MontosComprobante.desde("USD", { biDg: "0.15", igvDg: "0.03", total: "0.18" });
    const antes = JSON.stringify(usd);
    const pen = convertirAPen(usd, TipoCambio.desde("3.300"));
    expect(JSON.stringify(usd)).toBe(antes);
    expect(usd.moneda).toBe("USD");
    expect(Object.isFrozen(pen)).toBe(true);
    expect(pen).not.toBe(usd);
  });

  it("comprobante todo en 0.00 se convierte a 0.00", () => {
    const usd = MontosComprobante.desde("USD", { total: "0.00" });
    const pen = convertirAPen(usd, TipoCambio.desde("3.300"));
    expect(pen.total.toString()).toBe("0.00");
    expect(pen.moneda).toBe("PEN");
  });

  it("exige un comprobante en USD: uno en PEN lanza un error de dominio", () => {
    const enPen = MontosComprobante.desde("PEN", { biDg: "1.00", total: "1.00" });
    expect(() => convertirAPen(enPen, TipoCambio.desde("3.300"))).toThrow(DineroError);
  });

  it("R1b-5 opción A: un USD que no cuadra (incluso por 0.01) lanza ComprobanteDescuadradoError sin valores", () => {
    const usd = MontosComprobante.desde("USD", { biDg: "100.00", igvDg: "18.00", total: "118.01" });
    let e: unknown;
    try {
      convertirAPen(usd, TipoCambio.desde("3.500"));
    } catch (x) {
      e = x;
    }
    expect(e).toBeInstanceOf(ComprobanteDescuadradoError);
    expect((e as ComprobanteDescuadradoError).codigo).toBe("COMPROBANTE_DESCUADRADO");
    expect((e as Error).message).not.toMatch(/118|100|18\.0/);
  });

  it("R1b-5 opción A: un USD que cuadra se convierte (100.00 + 18.00 = 118.00 a TC 3.500)", () => {
    const usd = MontosComprobante.desde("USD", { biDg: "100.00", igvDg: "18.00", total: "118.00" });
    const pen = convertirAPen(usd, TipoCambio.desde("3.500"));
    expect([pen.obtener("biDg"), pen.obtener("igvDg"), pen.total].map(String)).toEqual(["350.00", "63.00", "413.00"]);
  });

  it("si la conversión excede el rango NUMERIC(14,2) lanza MontoFueraDeRangoError", () => {
    const usd = MontosComprobante.desde("USD", { biDg: "999999999999.99", total: "999999999999.99" });
    expect(() => convertirAPen(usd, TipoCambio.desde("3.300"))).toThrow(MontoFueraDeRangoError);
  });

  it("propiedad: cada columna = half-up del producto exacto (oráculo BigInt) y el total cuadra (semilla fija)", () => {
    fc.assert(
      fc.property(
        arbFila(),
        fc.integer({ min: 1, max: 9_999_999 }), // milésimas: 0.001 .. 9999.999
        (fila, milesimas) => {
          const usd = MontosComprobante.desde("USD", valores(fila) as never);
          const tcTxt = `${Math.trunc(milesimas / 1000)}.${String(milesimas % 1000).padStart(3, "0")}`;
          const pen = convertirAPen(usd, TipoCambio.desde(tcTxt));
          let sumaEsperada = 0n;
          for (const c of COLS) {
            const prod = BigInt(fila[c]) * BigInt(milesimas); // en 1e-5
            const abs = prod < 0n ? -prod : prod;
            const r = (abs + 500n) / 1000n; // half-up en centavos
            const esperado = prod < 0n ? -r : r;
            sumaEsperada += esperado;
            expect(pen.obtener(c).toString()).toBe(centavosAString(Number(esperado)));
          }
          expect(pen.total.toString()).toBe(centavosAString(Number(sumaEsperada)));
          expect(verificarCuadre(pen, tol0()).cuadra).toBe(true);
        },
      ),
      { seed: SEMILLA, numRuns: NUM_RUNS },
    );
  });
});

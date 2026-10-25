import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { arbFila, NUM_RUNS, SEMILLA, valores } from "../../tests/ayudas/comprobante";
import { Tolerancia, verificarCuadre } from "../dinero/index";
import { cambiarDestino } from "./cambiar-destino";
import type { ColumnaCompra, Destino } from "./columnas";
import { MontosComprobante } from "./montos-comprobante";

const tol0 = (): Tolerancia => Tolerancia.desde("0.00");
const DESTINOS: readonly Destino[] = ["DG", "DGNG", "DNG"];
const PAR: Record<Destino, { bi: ColumnaCompra; igv: ColumnaCompra }> = {
  DG: { bi: "biDg", igv: "igvDg" },
  DGNG: { bi: "biDgng", igv: "igvDgng" },
  DNG: { bi: "biDng", igv: "igvDng" },
};

describe("cambiarDestino", () => {
  it("CA-8: DG 100.00/18.00 -> DNG mueve el par, deja DG en 0.00 y conserva el total", () => {
    const m = MontosComprobante.desde("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.00" });
    const { montos } = cambiarDestino(m, "DNG");
    expect(montos.obtener("biDng").toString()).toBe("100.00");
    expect(montos.obtener("igvDng").toString()).toBe("18.00");
    expect(montos.obtener("biDg").toString()).toBe("0.00");
    expect(montos.obtener("igvDg").toString()).toBe("0.00");
    expect(montos.obtener("biDgng").toString()).toBe("0.00");
    expect(montos.obtener("igvDgng").toString()).toBe("0.00");
    expect(montos.total.toString()).toBe("118.00");
    expect(verificarCuadre(montos, tol0()).cuadra).toBe(true);
  });

  it("CA-8: el original no cambia y el resultado está congelado (inmutabilidad)", () => {
    const m = MontosComprobante.desde("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.00" });
    const antes = JSON.stringify(m);
    const r = cambiarDestino(m, "DNG");
    expect(JSON.stringify(m)).toBe(antes);
    expect(Object.isFrozen(m)).toBe(true);
    expect(Object.isFrozen(r.montos)).toBe(true);
    expect(r.montos).not.toBe(m);
  });

  it("informa que consolidó el destino de origen (DG) cuando tenía montos", () => {
    const m = MontosComprobante.desde("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.00" });
    expect(cambiarDestino(m, "DNG").consolidados).toEqual(["DG"]);
  });

  it("consolida varios destinos en el nuevo y los lista (orden DG, DGNG, DNG sin el destino)", () => {
    const m = MontosComprobante.desde("PEN", {
      biDg: "100.00", igvDg: "18.00", biDgng: "50.00", igvDgng: "9.00", biDng: "10.00", igvDng: "0.00",
      total: "187.00",
    });
    const aDng = cambiarDestino(m, "DNG");
    expect(aDng.montos.obtener("biDng").toString()).toBe("160.00");
    expect(aDng.montos.obtener("igvDng").toString()).toBe("27.00");
    expect(aDng.montos.obtener("biDg").toString()).toBe("0.00");
    expect(aDng.montos.obtener("igvDg").toString()).toBe("0.00");
    expect(aDng.montos.obtener("biDgng").toString()).toBe("0.00");
    expect(aDng.montos.obtener("igvDgng").toString()).toBe("0.00");
    expect(aDng.consolidados).toEqual(["DG", "DGNG"]);
    expect(aDng.montos.total.toString()).toBe("187.00");

    const aDg = cambiarDestino(m, "DG");
    expect(aDg.montos.obtener("biDg").toString()).toBe("160.00");
    expect(aDg.montos.obtener("igvDg").toString()).toBe("27.00");
    expect(aDg.consolidados).toEqual(["DGNG", "DNG"]);

    const aDgng = cambiarDestino(m, "DGNG");
    expect(aDgng.montos.obtener("biDgng").toString()).toBe("160.00");
    expect(aDgng.montos.obtener("igvDgng").toString()).toBe("27.00");
    expect(aDgng.consolidados).toEqual(["DG", "DNG"]);
  });

  it("un destino con solo IGV distinto de cero (BI 0.00) también cuenta como consolidado", () => {
    const m = MontosComprobante.desde("PEN", { biDg: "100.00", igvDgng: "5.00", total: "105.00" });
    const r = cambiarDestino(m, "DG");
    expect(r.consolidados).toEqual(["DGNG"]);
    expect(r.montos.obtener("biDg").toString()).toBe("100.00");
    expect(r.montos.obtener("igvDg").toString()).toBe("5.00");
    expect(r.montos.obtener("igvDgng").toString()).toBe("0.00");
  });

  it("los demás montos (no gravado, ISC, ICBPER, otros) y el total no se tocan", () => {
    const m = MontosComprobante.desde("PEN", {
      biDg: "100.00", igvDg: "18.00", noGravado: "7.00", isc: "3.00", icbper: "0.50",
      otrosTributos: "0.25", total: "128.75",
    });
    const { montos } = cambiarDestino(m, "DGNG");
    expect(montos.obtener("noGravado").toString()).toBe("7.00");
    expect(montos.obtener("isc").toString()).toBe("3.00");
    expect(montos.obtener("icbper").toString()).toBe("0.50");
    expect(montos.obtener("otrosTributos").toString()).toBe("0.25");
    expect(montos.total.toString()).toBe("128.75");
    expect(montos.obtener("biDgng").toString()).toBe("100.00");
    expect(montos.obtener("igvDgng").toString()).toBe("18.00");
  });

  it("mismo destino: sin cambios y consolidados vacío", () => {
    const m = MontosComprobante.desde("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.00" });
    const r = cambiarDestino(m, "DG");
    expect(JSON.stringify(r.montos)).toBe(JSON.stringify(m));
    expect(r.consolidados).toEqual([]);
  });

  it("D4: mismo destino con montos en otros destinos los consolida en ese destino", () => {
    const m = MontosComprobante.desde("PEN", {
      biDg: "100.00", igvDg: "18.00", biDgng: "50.00", igvDgng: "9.00", total: "177.00",
    });
    const r = cambiarDestino(m, "DG");
    expect(r.montos.obtener("biDg").toString()).toBe("150.00");
    expect(r.montos.obtener("igvDg").toString()).toBe("27.00");
    expect(r.montos.obtener("biDgng").toString()).toBe("0.00");
    expect(r.montos.obtener("igvDgng").toString()).toBe("0.00");
    expect(r.montos.total.toString()).toBe("177.00");
    expect(r.consolidados).toEqual(["DGNG"]);
  });

  it("fila sin montos en destinos: todo 0.00 y consolidados vacío", () => {
    const m = MontosComprobante.desde("PEN", { noGravado: "5.00", total: "5.00" });
    const r = cambiarDestino(m, "DNG");
    expect(r.consolidados).toEqual([]);
    expect(r.montos.obtener("biDng").toString()).toBe("0.00");
    expect(r.montos.total.toString()).toBe("5.00");
    expect(r.montos.obtener("noGravado").toString()).toBe("5.00");
  });

  it("nota de crédito: los pares negativos se mueven con su signo", () => {
    const m = MontosComprobante.desde("PEN", { biDg: "-100.00", igvDg: "-18.00", total: "-118.00" });
    const { montos, consolidados } = cambiarDestino(m, "DGNG");
    expect(montos.obtener("biDgng").toString()).toBe("-100.00");
    expect(montos.obtener("igvDgng").toString()).toBe("-18.00");
    expect(montos.obtener("biDg").toString()).toBe("0.00");
    expect(montos.total.toString()).toBe("-118.00");
    expect(consolidados).toEqual(["DG"]);
  });

  it("conserva la moneda (USD) del comprobante", () => {
    const m = MontosComprobante.desde("USD", { biDg: "0.15", igvDg: "0.03", total: "0.18" });
    const { montos } = cambiarDestino(m, "DNG");
    expect(montos.moneda).toBe("USD");
    expect(montos.obtener("biDng").moneda).toBe("USD");
    expect(montos.obtener("biDng").toString()).toBe("0.15");
  });

  it("propiedad: cadenas de cambiarDestino conservan Σ columnas = total y dejan todo en el último destino (semilla fija)", () => {
    fc.assert(
      fc.property(
        arbFila(),
        fc.array(fc.constantFrom(...DESTINOS), { minLength: 1, maxLength: 8 }),
        (fila, cadena) => {
          let m = MontosComprobante.desde("PEN", valores(fila) as never);
          const totalOriginal = m.total.toString();
          for (const d of cadena) {
            const r = cambiarDestino(m, d);
            expect(Object.isFrozen(r.montos)).toBe(true);
            m = r.montos;
            expect(m.total.toString()).toBe(totalOriginal);
            expect(verificarCuadre(m, tol0()).cuadra).toBe(true);
          }
          const ult = cadena[cadena.length - 1]!;
          for (const o of DESTINOS.filter((x) => x !== ult)) {
            expect(m.obtener(PAR[o].bi).toString()).toBe("0.00");
            expect(m.obtener(PAR[o].igv).toString()).toBe("0.00");
          }
        },
      ),
      { seed: SEMILLA, numRuns: NUM_RUNS },
    );
  });
});

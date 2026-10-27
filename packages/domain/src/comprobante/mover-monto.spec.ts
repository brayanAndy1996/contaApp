import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { arbFila, COLS, NUM_RUNS, SEMILLA, valores } from "../../tests/ayudas/comprobante";
import {
  MonedaDistintaError, Money, MovimientoInvalidoError, Tolerancia, verificarCuadre,
} from "../dinero/index";
import type { ColumnaCompra } from "./columnas";
import { moverMonto } from "./mover-monto";
import { MontosComprobante } from "./montos-comprobante";

const tol0 = (): Tolerancia => Tolerancia.desde("0.00");
const pen = (s: string): Money => Money.desde(s, "PEN");

function sumaColumnas(m: MontosComprobante): string {
  return verificarCuadre(m, tol0()).sumaComponentes.toString();
}

describe("moverMonto: casos válidos", () => {
  it("mueve un monto parcial entre dos columnas y conserva el total y Σ columnas", () => {
    const m = MontosComprobante.desde("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.00" });
    const r = moverMonto(m, "biDg", "noGravado", pen("40.25"));
    expect(r.obtener("biDg").toString()).toBe("59.75");
    expect(r.obtener("noGravado").toString()).toBe("40.25");
    expect(r.obtener("igvDg").toString()).toBe("18.00");
    expect(r.total.toString()).toBe("118.00");
    expect(sumaColumnas(r)).toBe(sumaColumnas(m));
    expect(verificarCuadre(r, tol0()).cuadra).toBe(true);
  });

  it("mover todo el saldo deja el origen en 0.00", () => {
    const m = MontosComprobante.desde("PEN", { biDg: "100.00", total: "100.00" });
    const r = moverMonto(m, "biDg", "isc", pen("100.00"));
    expect(r.obtener("biDg").toString()).toBe("0.00");
    expect(r.obtener("biDg").esCero()).toBe(true);
    expect(r.obtener("isc").toString()).toBe("100.00");
  });

  it("acumula en un destino que ya tenía saldo", () => {
    const m = MontosComprobante.desde("PEN", { biDg: "10.00", isc: "5.00", total: "15.00" });
    const r = moverMonto(m, "biDg", "isc", pen("3.50"));
    expect(r.obtener("isc").toString()).toBe("8.50");
    expect(r.obtener("biDg").toString()).toBe("6.50");
  });

  it("permite mover entre columnas de BI e IGV, ICBPER y otros tributos", () => {
    const m = MontosComprobante.desde("PEN", { igvDg: "18.00", icbper: "0.50", total: "18.50" });
    const a = moverMonto(m, "igvDg", "otrosTributos", pen("1.00"));
    expect(a.obtener("otrosTributos").toString()).toBe("1.00");
    const b = moverMonto(a, "icbper", "biDng", pen("0.50"));
    expect(b.obtener("biDng").toString()).toBe("0.50");
    expect(b.total.toString()).toBe("18.50");
  });

  it("no muta el original y el resultado está congelado", () => {
    const m = MontosComprobante.desde("PEN", { biDg: "100.00", total: "100.00" });
    const antes = JSON.stringify(m);
    const r = moverMonto(m, "biDg", "isc", pen("10.00"));
    expect(JSON.stringify(m)).toBe(antes);
    expect(Object.isFrozen(r)).toBe(true);
    expect(r).not.toBe(m);
  });

  it("conserva la moneda USD del comprobante", () => {
    const m = MontosComprobante.desde("USD", { biDg: "1.00", total: "1.00" });
    const r = moverMonto(m, "biDg", "isc", Money.desde("0.40", "USD"));
    expect(r.moneda).toBe("USD");
    expect(r.obtener("isc").toString()).toBe("0.40");
    expect(r.obtener("isc").moneda).toBe("USD");
  });
});

describe("moverMonto: inválidos (CA-9)", () => {
  const base = MontosComprobante.desde("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.00" });

  it("monto mayor que el saldo de origen", () => {
    expect(() => moverMonto(base, "biDg", "isc", pen("100.01"))).toThrow(MovimientoInvalidoError);
    expect(() => moverMonto(base, "igvDg", "isc", pen("18.01"))).toThrow(MovimientoInvalidoError);
  });

  it("monto negativo con saldo positivo", () => {
    expect(() => moverMonto(base, "biDg", "isc", pen("-1.00"))).toThrow(MovimientoInvalidoError);
  });

  it("monto cero", () => {
    expect(() => moverMonto(base, "biDg", "isc", pen("0.00"))).toThrow(MovimientoInvalidoError);
    expect(() => moverMonto(base, "biDg", "isc", pen("-0.00"))).toThrow(MovimientoInvalidoError);
  });

  it("origen igual a destino", () => {
    expect(() => moverMonto(base, "biDg", "biDg", pen("1.00"))).toThrow(MovimientoInvalidoError);
  });

  it("saldo de origen 0.00: cualquier monto es inválido", () => {
    expect(() => moverMonto(base, "isc", "biDg", pen("1.00"))).toThrow(MovimientoInvalidoError);
    expect(() => moverMonto(base, "isc", "biDg", pen("-1.00"))).toThrow(MovimientoInvalidoError);
    expect(() => moverMonto(base, "isc", "biDg", pen("0.00"))).toThrow(MovimientoInvalidoError);
  });

  it("un movimiento inválido no altera el original", () => {
    const antes = JSON.stringify(base);
    expect(() => moverMonto(base, "biDg", "isc", pen("500.00"))).toThrow(MovimientoInvalidoError);
    expect(JSON.stringify(base)).toBe(antes);
  });

  it("CA-7: monto en otra moneda lanza MonedaDistintaError", () => {
    expect(() => moverMonto(base, "biDg", "isc", Money.desde("1.00", "USD"))).toThrow(MonedaDistintaError);
    const usd = MontosComprobante.desde("USD", { biDg: "10.00", total: "10.00" });
    expect(() => moverMonto(usd, "biDg", "isc", pen("1.00"))).toThrow(MonedaDistintaError);
  });
});

describe("moverMonto: notas de crédito (D6, saldo negativo)", () => {
  const nc = MontosComprobante.desde("PEN", { biDg: "-100.00", igvDg: "-18.00", total: "-118.00" });

  it("monto negativo con |monto| <= |saldo| es válido y conserva el total", () => {
    const r = moverMonto(nc, "biDg", "noGravado", pen("-30.00"));
    expect(r.obtener("biDg").toString()).toBe("-70.00");
    expect(r.obtener("noGravado").toString()).toBe("-30.00");
    expect(r.total.toString()).toBe("-118.00");
    expect(sumaColumnas(r)).toBe("-118.00");
  });

  it("monto negativo igual al saldo deja el origen en 0.00", () => {
    const r = moverMonto(nc, "biDg", "isc", pen("-100.00"));
    expect(r.obtener("biDg").toString()).toBe("0.00");
    expect(r.obtener("isc").toString()).toBe("-100.00");
  });

  it("monto positivo con saldo negativo es inválido", () => {
    expect(() => moverMonto(nc, "biDg", "isc", pen("30.00"))).toThrow(MovimientoInvalidoError);
  });

  it("|monto| mayor que |saldo| es inválido", () => {
    expect(() => moverMonto(nc, "biDg", "isc", pen("-100.01"))).toThrow(MovimientoInvalidoError);
  });

  it("monto cero y saldo 0.00 siguen siendo inválidos", () => {
    expect(() => moverMonto(nc, "biDg", "isc", pen("0.00"))).toThrow(MovimientoInvalidoError);
    expect(() => moverMonto(nc, "isc", "biDg", pen("-1.00"))).toThrow(MovimientoInvalidoError);
  });
});

describe("moverMonto: propiedad de conservación (CA-9, semilla fija)", () => {
  const arbOp = fc.record({
    origen: fc.constantFrom(...COLS),
    destino: fc.constantFrom(...COLS),
    fraccion: fc.integer({ min: -2, max: 12 }), // fracción del saldo en décimos; fuera de 1..10 provoca inválidos
  });

  it("cadenas de moverMonto (válidas o rechazadas) conservan Σ columnas y total", () => {
    fc.assert(
      fc.property(arbFila(), fc.array(arbOp, { minLength: 1, maxLength: 12 }), (fila, ops) => {
        let m = MontosComprobante.desde("PEN", valores(fila) as never);
        const totalOriginal = m.total.toString();
        for (const op of ops) {
          const saldo = m.obtener(op.origen);
          // monto = saldo * fraccion / 10 en centavos, calculado con Money (sin number para dinero)
          const monto = Money.desde(
            ((): string => {
              const c = BigInt(saldo.toString().replace(".", ""));
              const x = (c * BigInt(op.fraccion)) / 10n;
              const a = x < 0n ? -x : x;
              const s = `${x < 0n ? "-" : ""}${a / 100n}.${String(a % 100n).padStart(2, "0")}`;
              return s;
            })(),
            "PEN",
          );
          const antes = sumaColumnas(m);
          try {
            const r = moverMonto(m, op.origen as ColumnaCompra, op.destino as ColumnaCompra, monto);
            expect(Object.isFrozen(r)).toBe(true);
            expect(sumaColumnas(r)).toBe(antes);
            m = r;
          } catch (e) {
            expect(e).toBeInstanceOf(MovimientoInvalidoError);
          }
          expect(m.total.toString()).toBe(totalOriginal);
          expect(sumaColumnas(m)).toBe(antes);
        }
        expect(verificarCuadre(m, tol0()).cuadra).toBe(true);
      }),
      { seed: SEMILLA, numRuns: NUM_RUNS },
    );
  });
});

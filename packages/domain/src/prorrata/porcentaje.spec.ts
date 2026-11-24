// Spec 026 · T1 (rojo). porcentajeProrrata(numerador: Money, total: Money) → Porcentaje (R-3, U-7; CA-2).
// Contrato (plan 026): `Porcentaje` opaco con `toString()` «NN.NN» y `comoFactor()` (= porcentaje/100 como Factor); cociente
// exacto y redondeo mitad hacia arriba a 2 decimales; solo con 0 ≤ numerador ≤ total y total > 0, fuera de eso lanza.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { redondearSunat } from "../dinero/index";
import { SEMILLA } from "../../tests/ayudas/comprobante";
import { aTexto, pen } from "../../tests/ayudas/prorrata";
import { porcentajeProrrata } from "./porcentaje";

/** Oráculo: centésimas de punto = round_half_up(numerador × 10000 / total) con enteros (céntimos); sin decimal.js. */
function oraculo(num: bigint, total: bigint): string {
  const c = (2n * num * 10000n + total) / (2n * total);
  return `${c / 100n}.${(c % 100n).toString().padStart(2, "0")}`;
}

const pct = (n: string, t: string): string => porcentajeProrrata(pen(n), pen(t)).toString();

describe("porcentajeProrrata: redondeo a 2 decimales mitad hacia arriba (U-7)", () => {
  it.each([
    ["87.345 exacto sube", "87345.00", "100000.00", "87.35"],
    ["87.344 baja", "87344.00", "100000.00", "87.34"],
    ["87.34499 baja", "87344.99", "100000.00", "87.34"],
    ["87.34501 sube", "87345.01", "100000.00", "87.35"],
    ["3.125 exacto sube", "1.00", "32.00", "3.13"],
    ["0.625 exacto sube", "1.00", "160.00", "0.63"],
    ["0.375 exacto sube", "3.00", "800.00", "0.38"],
    ["12.5 no necesita redondeo", "1.00", "8.00", "12.50"],
    ["1/3 → 33.33", "1.00", "3.00", "33.33"],
    ["2/3 → 66.67", "2.00", "3.00", "66.67"],
    ["numerador = total → 100.00", "500.00", "500.00", "100.00"],
    ["numerador 0 → 0.00", "0.00", "500.00", "0.00"],
    ["el mínimo 0.01 sobre 12 dígitos → 0.00", "0.01", "999999999999.99", "0.00"],
    ["12 dígitos iguales → 100.00", "999999999999.99", "999999999999.99", "100.00"],
    ["12 dígitos casi iguales → 100.00", "999999999999.98", "999999999999.99", "100.00"],
    ["mitad de 12 dígitos", "499999999999.99", "999999999999.98", "50.00"],
  ])("%s", (_n, num, total, esperado) => {
    expect(pct(num, total)).toBe(esperado);
  });

  it("coincide con el oráculo en una tabla de borde con montos de hasta 12 dígitos", () => {
    const montos = [1n, 2n, 3n, 7n, 99n, 100n, 12345n, 99999n, 87345n, 100000n, 99999999999999n, 49999999999999n];
    for (const t of montos) {
      for (const n of [0n, 1n, t / 3n, t / 2n, t - 1n, t].filter((x) => x >= 0n && x <= t)) {
        expect(pct(aTexto(n), aTexto(t))).toBe(oraculo(n, t));
      }
    }
  });

  it("Porcentaje es un objeto (no `number`) y su texto es «NN.NN» con 2 decimales y hasta 3 enteros", () => {
    const p = porcentajeProrrata(pen("1.00"), pen("3.00"));
    expect(typeof p).toBe("object");
    expect(p.toString()).toMatch(/^(100|[0-9]{1,2})\.[0-9]{2}$/);
    expect(pct("0.00", "1.00")).toBe("0.00");
    expect(pct("1.00", "1.00")).toBe("100.00");
  });

  it("comoFactor() es porcentaje/100: aplicado a 10000.00 devuelve el porcentaje × 100 sin pérdida", () => {
    const casos: [string, string, string][] = [
      ["87345.00", "100000.00", "8735.00"],
      ["87344.00", "100000.00", "8734.00"],
      ["1.00", "3.00", "3333.00"],
      ["500.00", "500.00", "10000.00"],
      ["0.00", "500.00", "0.00"],
    ];
    for (const [n, t, esperado] of casos) {
      const f = porcentajeProrrata(pen(n), pen(t)).comoFactor();
      expect(redondearSunat(pen("10000.00").por(f)).toString()).toBe(esperado);
    }
  });

  it("propiedad (10.000 casos): igual al oráculo en céntimos, siempre entre 0.00 y 100.00, y monótono en el numerador", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 99_999_999_999_999n }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (total, a, b) => {
          const n1 = BigInt(Math.floor(a * Number(total)));
          const n2 = BigInt(Math.floor(b * Number(total)));
          const [menor, mayor] = n1 <= n2 ? [n1, n2] : [n2, n1];
          const p1 = pct(aTexto(menor), aTexto(total));
          const p2 = pct(aTexto(mayor), aTexto(total));
          expect(p1).toBe(oraculo(menor, total));
          expect(p2).toBe(oraculo(mayor, total));
          const c1 = BigInt(p1.replace(".", ""));
          const c2 = BigInt(p2.replace(".", ""));
          expect(c1 <= c2).toBe(true);
          expect(c2 <= 10000n).toBe(true);
        },
      ),
      { numRuns: 10_000, seed: SEMILLA },
    );
  });
});

describe("porcentajeProrrata: fuera de dominio lanza", () => {
  it.each([
    ["numerador mayor que el total", "100.01", "100.00"],
    ["numerador negativo", "-0.01", "100.00"],
    ["total 0 con numerador 0", "0.00", "0.00"],
    ["total negativo", "0.00", "-100.00"],
    ["ambos negativos", "-1.00", "-1.00"],
  ])("%s", (_n, num, total) => {
    expect(() => porcentajeProrrata(pen(num), pen(total))).toThrow();
  });

  it.each<[string, unknown, unknown]>([
    ["numerador `number`", 50, pen("100.00")],
    ["total `number`", pen("50.00"), 100],
    ["ambos cadenas", "50.00", "100.00"],
    ["null", null, pen("100.00")],
    ["undefined", pen("50.00"), undefined],
    ["un falso Money", { moneda: "PEN" }, pen("100.00")],
  ])("entrada que no es Money (%s) lanza", (_n, num, total) => {
    expect(() => porcentajeProrrata(num as never, total as never)).toThrow();
  });
});

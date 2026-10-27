import { beforeEach, describe, expect, it } from "vitest";
import {
  DineroError,
  Money,
  MonedaDistintaError,
  TASA_IGV_10,
  TASA_IGV_18,
  Tolerancia,
  TOLERANCIA_CUADRE,
  TOLERANCIA_IGV,
  igvCuadra,
  igvEsperado,
} from "../index";

// D2 (±0.01 solo para IGV contra base × tasa), D3 (igvEsperado/igvCuadra en 010) y
// caso real de la mixta 21.48 / 1.61.

const pen = (s: string): Money => Money.desde(s, "PEN");

/** Si la API pública aún no exporta algo, TODA prueba falla por esa razón (rojo explícito). */
beforeEach(() => {
  const funciones: Record<string, unknown> = {
    DineroError,
    Money,
    MonedaDistintaError,
    Tolerancia,
    igvCuadra,
    igvEsperado,
  };
  for (const [nombre, valor] of Object.entries(funciones)) {
    expect(valor, `@contapp/domain debe exportar ${nombre}`).toBeTypeOf(
      "function",
    );
  }
  const valores: Record<string, unknown> = {
    TASA_IGV_10,
    TASA_IGV_18,
    TOLERANCIA_CUADRE,
    TOLERANCIA_IGV,
  };
  for (const [nombre, valor] of Object.entries(valores)) {
    expect(valor, `@contapp/domain debe exportar ${nombre}`).toBeDefined();
  }
});

describe("igvEsperado (D3)", () => {
  it("100.00 al 18 % = 18.00 y al 10 % = 10.00", () => {
    expect(igvEsperado(pen("100.00"), TASA_IGV_18).toString()).toBe("18.00");
    expect(igvEsperado(pen("100.00"), TASA_IGV_10).toString()).toBe("10.00");
  });
  it("2.25 al 18 % = 0.405 → 0.41 (half-up, D1)", () => {
    expect(igvEsperado(pen("2.25"), TASA_IGV_18).toString()).toBe("0.41");
  });
  it("las dos tasas son distintas", () => {
    expect(igvEsperado(pen("50.00"), TASA_IGV_18).toString()).toBe("9.00");
    expect(igvEsperado(pen("50.00"), TASA_IGV_10).toString()).toBe("5.00");
  });
  it("negativos (nota de crédito): -2.25 al 18 % = -0.41", () => {
    expect(igvEsperado(pen("-2.25"), TASA_IGV_18).toString()).toBe("-0.41");
  });
  it("base cero da 0.00", () => {
    expect(igvEsperado(pen("0.00"), TASA_IGV_18).toString()).toBe("0.00");
  });
  it("conserva la moneda de la base", () => {
    const r = igvEsperado(Money.desde("100.00", "USD"), TASA_IGV_18);
    expect(r.moneda).toBe("USD");
    expect(r.toString()).toBe("18.00");
  });
  it("caso real mixta: 8.97 → 1.61, 8.92 → 1.61, 8.91 → 1.60, 8.98 → 1.62 (18 %)", () => {
    expect(igvEsperado(pen("8.97"), TASA_IGV_18).toString()).toBe("1.61");
    expect(igvEsperado(pen("8.92"), TASA_IGV_18).toString()).toBe("1.61");
    expect(igvEsperado(pen("8.91"), TASA_IGV_18).toString()).toBe("1.60");
    expect(igvEsperado(pen("8.98"), TASA_IGV_18).toString()).toBe("1.62");
  });
  it("caso real mixta: 21.48 → 3.87 (18 %) y 2.15 (10 %)", () => {
    expect(igvEsperado(pen("21.48"), TASA_IGV_18).toString()).toBe("3.87");
    expect(igvEsperado(pen("21.48"), TASA_IGV_10).toString()).toBe("2.15");
  });
});

describe("igvCuadra (D2: tolerancia ±0.01 por defecto)", () => {
  it("caso real mixta: igvCuadra(21.48, 1.61) es falso a 18 % y a 10 %", () => {
    expect(igvCuadra(pen("21.48"), pen("1.61"), TASA_IGV_18)).toBe(false);
    expect(igvCuadra(pen("21.48"), pen("1.61"), TASA_IGV_10)).toBe(false);
  });
  it("exacto cuadra: 100.00 / 18.00", () => {
    expect(igvCuadra(pen("100.00"), pen("18.00"), TASA_IGV_18)).toBe(true);
    expect(igvCuadra(pen("100.00"), pen("10.00"), TASA_IGV_10)).toBe(true);
    expect(igvCuadra(pen("100.00"), pen("18.00"), TASA_IGV_10)).toBe(false);
  });
  it("±0.01 cuadra (inclusivo) y ±0.02 no, con la tolerancia por defecto", () => {
    // esperado 18.00
    expect(igvCuadra(pen("100.00"), pen("18.01"), TASA_IGV_18)).toBe(true);
    expect(igvCuadra(pen("100.00"), pen("17.99"), TASA_IGV_18)).toBe(true);
    expect(igvCuadra(pen("100.00"), pen("18.02"), TASA_IGV_18)).toBe(false);
    expect(igvCuadra(pen("100.00"), pen("17.98"), TASA_IGV_18)).toBe(false);
  });
  it("caso real: base 8.97 con IGV 1.60, 1.61 y 1.62 cuadra; 1.59 y 1.63 no", () => {
    for (const igv of ["1.60", "1.61", "1.62"]) {
      expect(igvCuadra(pen("8.97"), pen(igv), TASA_IGV_18)).toBe(true);
    }
    for (const igv of ["1.59", "1.63"]) {
      expect(igvCuadra(pen("8.97"), pen(igv), TASA_IGV_18)).toBe(false);
    }
  });
  it("tolerancia 0.00 explícita exige igualdad", () => {
    expect(
      igvCuadra(pen("100.00"), pen("18.00"), TASA_IGV_18, TOLERANCIA_CUADRE),
    ).toBe(true);
    expect(
      igvCuadra(pen("100.00"), pen("18.01"), TASA_IGV_18, TOLERANCIA_CUADRE),
    ).toBe(false);
    expect(
      igvCuadra(
        pen("8.97"),
        pen("1.62"),
        TASA_IGV_18,
        Tolerancia.desde("0.00"),
      ),
    ).toBe(false);
  });
  it("tolerancia mayor explícita: 0.05", () => {
    const t = Tolerancia.desde("0.05");
    expect(igvCuadra(pen("100.00"), pen("18.05"), TASA_IGV_18, t)).toBe(true);
    expect(igvCuadra(pen("100.00"), pen("18.06"), TASA_IGV_18, t)).toBe(false);
  });
  it("TOLERANCIA_IGV explícita equivale al valor por defecto", () => {
    expect(
      igvCuadra(pen("100.00"), pen("18.01"), TASA_IGV_18, TOLERANCIA_IGV),
    ).toBe(true);
    expect(
      igvCuadra(pen("100.00"), pen("18.02"), TASA_IGV_18, TOLERANCIA_IGV),
    ).toBe(false);
  });
  it("negativos (nota de crédito): -8.97 con -1.61 cuadra; -8.97 con +1.61 no", () => {
    expect(igvCuadra(pen("-8.97"), pen("-1.61"), TASA_IGV_18)).toBe(true);
    expect(igvCuadra(pen("-8.97"), pen("1.61"), TASA_IGV_18)).toBe(false);
  });
  it("base cero con IGV 0.00 cuadra; con 0.02 no", () => {
    expect(igvCuadra(pen("0.00"), pen("0.00"), TASA_IGV_18)).toBe(true);
    expect(igvCuadra(pen("0.00"), pen("0.02"), TASA_IGV_18)).toBe(false);
  });
  it("monedas distintas entre base e IGV lanzan MonedaDistintaError", () => {
    expect(() =>
      igvCuadra(pen("100.00"), Money.desde("18.00", "USD"), TASA_IGV_18),
    ).toThrow(MonedaDistintaError);
    expect(() =>
      igvCuadra(pen("100.00"), Money.desde("18.00", "USD"), TASA_IGV_18),
    ).toThrow(DineroError);
  });
  it("igvCuadra con USD cuando ambos son USD", () => {
    expect(
      igvCuadra(
        Money.desde("100.00", "USD"),
        Money.desde("18.00", "USD"),
        TASA_IGV_18,
      ),
    ).toBe(true);
  });
});

describe("Tolerancia (>= 0, hasta 2 decimales)", () => {
  it.each(["0", "0.00", "0.01", "1", "1.50"])("acepta %s", (s) => {
    expect(() => Tolerancia.desde(s)).not.toThrow();
  });
  const invalidos: Array<[string, unknown]> = [
    ["negativa", "-0.01"],
    ["3 decimales", "0.001"],
    ["vacía", ""],
    ["texto", "abc"],
    ["notación científica", "1e-2"],
    ["coma", "0,01"],
    ["number", 0.01],
    ["null", null],
  ];
  it.each(invalidos)("rechaza %s con DineroError", (_n, v) => {
    expect(() => Tolerancia.desde(v as unknown as string)).toThrow(DineroError);
  });
  it("es inmutable", () => {
    expect(Object.isFrozen(Tolerancia.desde("0.01"))).toBe(true);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import {
  DineroError,
  Factor,
  FactorInvalidoError,
  Money,
  TipoCambio,
  redondearSunat,
} from "../index";

// Factor (hasta 10 decimales, >= 0) y TipoCambio (hasta 3 decimales, > 0). D7 y plan 010.

/** Si la API pública aún no exporta algo, TODA prueba falla por esa razón (rojo explícito). */
beforeEach(() => {
  const funciones: Record<string, unknown> = {
    DineroError,
    Factor,
    FactorInvalidoError,
    Money,
    TipoCambio,
    redondearSunat,
  };
  for (const [nombre, valor] of Object.entries(funciones)) {
    expect(valor, `@contapp/domain debe exportar ${nombre}`).toBeTypeOf(
      "function",
    );
  }
  const valores: Record<string, unknown> = {};
  for (const [nombre, valor] of Object.entries(valores)) {
    expect(valor, `@contapp/domain debe exportar ${nombre}`).toBeDefined();
  }
});

describe("Factor", () => {
  it.each([
    "0",
    "1",
    "0.18",
    "0.1",
    "1.0000000001",
    "123456",
    "123456.1234567890",
    "0.0000000001",
  ])("acepta %s", (s) => {
    expect(() => Factor.desde(s)).not.toThrow();
  });

  const invalidos: Array<[string, unknown]> = [
    ["más de 10 decimales", "0.12345678901"],
    ["más de 6 enteros", "1234567"],
    ["negativo", "-1"],
    ["negativo con decimales", "-0.18"],
    ["vacío", ""],
    ["notación científica", "1e3"],
    ["coma decimal", "0,18"],
    ["espacio", " 0.18"],
    ["signo +", "+0.18"],
    ["ceros a la izquierda", "01.5"],
    [".5", ".5"],
    ["5.", "5."],
    ["number", 0.18],
    ["NaN", Number.NaN],
    ["null", null],
    ["undefined", undefined],
    ["objeto con toString", { toString: () => "0.18" }],
    ["dígitos árabes", "٠.١٨"],
  ];
  it.each(invalidos)("rechaza %s con FactorInvalidoError", (_n, v) => {
    expect(() => Factor.desde(v as unknown as string)).toThrow(
      FactorInvalidoError,
    );
  });

  it("FactorInvalidoError es DineroError con `codigo` y mensaje que no incluye el valor", () => {
    let error: unknown;
    try {
      Factor.desde("-7654.321");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DineroError);
    expect(typeof (error as { codigo?: unknown }).codigo).toBe("string");
    expect((error as Error).message).not.toContain("7654");
  });

  it("es inmutable", () => {
    expect(Object.isFrozen(Factor.desde("0.18"))).toBe(true);
  });

  it("un Factor de 10 decimales multiplica con exactitud", () => {
    // 100.00 × 0.0000000001 = 0.00000001 → 0.00
    expect(
      redondearSunat(
        Money.desde("100.00", "PEN").por(Factor.desde("0.0000000001")),
      ).toString(),
    ).toBe("0.00");
    // 1000000.00 × 0.0000000050 = 0.005 → 0.01
    expect(
      redondearSunat(
        Money.desde("1000000.00", "PEN").por(Factor.desde("0.0000000050")),
      ).toString(),
    ).toBe("0.01");
  });
});

describe("TipoCambio (D7: hasta 3 decimales, mayor que cero)", () => {
  it.each(["3.3", "3.300", "3.333", "0.001", "1", "9999.999", "3.75"])(
    "acepta %s",
    (s) => {
      expect(() => TipoCambio.desde(s)).not.toThrow();
    },
  );

  const invalidos: Array<[string, unknown]> = [
    ["más de 3 decimales", "3.3333"],
    ["4 decimales con cero final", "3.3000"],
    ["cero", "0"],
    ["cero con decimales", "0.000"],
    ["negativo", "-3.3"],
    ["más de 4 enteros", "10000"],
    ["vacío", ""],
    ["notación científica", "3.3e0"],
    ["coma decimal", "3,3"],
    ["espacio", "3.3 "],
    ["signo +", "+3.3"],
    ["ceros a la izquierda", "03.3"],
    ["number", 3.3],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["null", null],
    ["undefined", undefined],
    ["dígitos árabes", "٣.٣"],
  ];
  it.each(invalidos)("rechaza %s con DineroError", (_n, v) => {
    expect(() => TipoCambio.desde(v as unknown as string)).toThrow(DineroError);
  });

  it("es inmutable", () => {
    expect(Object.isFrozen(TipoCambio.desde("3.300"))).toBe(true);
  });

  it("multiplicar USD por TC 3.300: 0.15 → 0.495 → 0.50; 0.03 → 0.099 → 0.10", () => {
    const tc = TipoCambio.desde("3.300");
    expect(redondearSunat(Money.desde("0.15", "USD").por(tc)).toString()).toBe(
      "0.50",
    );
    expect(redondearSunat(Money.desde("0.03", "USD").por(tc)).toString()).toBe(
      "0.10",
    );
    expect(redondearSunat(Money.desde("0.18", "USD").por(tc)).toString()).toBe(
      "0.59",
    );
  });

  it("TC de 3 decimales: 100.00 × 3.333 = 333.30 y 0.01 × 3.333 = 0.03333 → 0.03", () => {
    const tc = TipoCambio.desde("3.333");
    expect(
      redondearSunat(Money.desde("100.00", "USD").por(tc)).toString(),
    ).toBe("333.30");
    expect(redondearSunat(Money.desde("0.01", "USD").por(tc)).toString()).toBe(
      "0.03",
    );
  });

  it("por TC en negativos es simétrico (nota de crédito en USD)", () => {
    const tc = TipoCambio.desde("3.300");
    expect(redondearSunat(Money.desde("-0.15", "USD").por(tc)).toString()).toBe(
      "-0.50",
    );
  });
});

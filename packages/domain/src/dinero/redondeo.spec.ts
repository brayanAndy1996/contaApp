import fc from "fast-check";
import { Decimal } from "decimal.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DineroError,
  Factor,
  FactorInvalidoError,
  Money,
  MontoExacto,
  MontoFueraDeRangoError,
  MontoInvalidoError,
  TipoCambio,
  redondearSunat,
} from "../index";

// Redondeo SUNAT (D1: half-up alejándose de cero a 2 decimales). CA-3 (producto),
// CA-4, D7 (TC) y las adiciones `entre` y MontoExacto del plan 010.

const pen = (s: string): Money => Money.desde(s, "PEN");
const exacto = (s: string): MontoExacto => MontoExacto.desde(s, "PEN");

/** Si la API pública aún no exporta algo, TODA prueba falla por esa razón (rojo explícito). */
beforeEach(() => {
  const funciones: Record<string, unknown> = {
    DineroError,
    Factor,
    FactorInvalidoError,
    Money,
    MontoExacto,
    MontoFueraDeRangoError,
    MontoInvalidoError,
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

describe("CA-4 · redondearSunat half-up alejándose de cero (D1)", () => {
  it("2.25 × 0.18 = 0.405 → 0.41 (no 0.40)", () => {
    expect(
      redondearSunat(pen("2.25").por(Factor.desde("0.18"))).toString(),
    ).toBe("0.41");
  });
  it("-2.25 × 0.18 = -0.405 → -0.41 (simétrico)", () => {
    expect(
      redondearSunat(pen("-2.25").por(Factor.desde("0.18"))).toString(),
    ).toBe("-0.41");
  });

  const tabla: Array<[string, string]> = [
    ["0.0049999999", "0.00"],
    ["0.004999999999", "0.00"],
    ["0.005", "0.01"],
    ["0.015", "0.02"],
    ["0.025", "0.03"],
    ["0.035", "0.04"],
    ["0.045", "0.05"],
    ["0.105", "0.11"],
    ["1.005", "1.01"],
    ["2.675", "2.68"],
    ["0.0050000001", "0.01"],
    ["-0.005", "-0.01"],
    ["-0.015", "-0.02"],
    ["-0.025", "-0.03"],
    ["-1.005", "-1.01"],
    ["-0.0049999999", "0.00"],
    ["-0.004", "0.00"],
    ["0", "0.00"],
    ["12.3", "12.30"],
    ["12.34", "12.34"],
    ["12.344999", "12.34"],
    ["12.345", "12.35"],
    ["999999999999.994", "999999999999.99"],
    ["-999999999999.994", "-999999999999.99"],
    ["0.0000000001", "0.00"],
  ];
  it.each(tabla)("redondearSunat(MontoExacto %s) = %s", (entrada, esperado) => {
    expect(redondearSunat(exacto(entrada)).toString()).toBe(esperado);
  });

  it("el resultado de redondear un negativo que cae en 0 es 0.00, nunca -0.00", () => {
    const r = redondearSunat(exacto("-0.004"));
    expect(r.toString()).toBe("0.00");
    expect(r.esCero()).toBe(true);
    expect(JSON.stringify(r)).not.toContain("-0");
  });

  it("medio centavo obtenido por producto: 0.05 × 0.1 = 0.005 → 0.01 y 0.15 × 0.1 → 0.02", () => {
    expect(
      redondearSunat(pen("0.05").por(Factor.desde("0.1"))).toString(),
    ).toBe("0.01");
    expect(
      redondearSunat(pen("0.15").por(Factor.desde("0.1"))).toString(),
    ).toBe("0.02");
    expect(
      redondearSunat(pen("-0.15").por(Factor.desde("0.1"))).toString(),
    ).toBe("-0.02");
  });

  it("devuelve Money y conserva la moneda del monto exacto", () => {
    const r = redondearSunat(MontoExacto.desde("1.005", "USD"));
    expect(r).toBeInstanceOf(Money);
    expect(r.moneda).toBe("USD");
    expect(r.toString()).toBe("1.01");
    expect(Object.isFrozen(r)).toBe(true);
  });

  it("el producto no se redondea hasta llamar a redondearSunat (sin pérdida)", () => {
    // 3 pasos de ×0.1 sobre 1.00 siguen exactos: 0.001 → 0.00; con ×0.5 sobre 0.01 → 0.005 → 0.01
    const x = pen("0.01").por(Factor.desde("0.5"));
    expect(redondearSunat(x).toString()).toBe("0.01");
    expect(
      redondearSunat(
        pen("1.00").por(Factor.desde("0.1")).por(Factor.desde("0.05")),
      ).toString(),
    ).toBe("0.01");
  });

  it("0.1 × 3 y 0.7 × 0.1 no arrastran error de coma flotante", () => {
    expect(redondearSunat(pen("0.10").por(Factor.desde("3"))).toString()).toBe(
      "0.30",
    );
    expect(
      redondearSunat(pen("0.70").por(Factor.desde("0.1"))).toString(),
    ).toBe("0.07");
    expect(
      redondearSunat(pen("1.10").por(Factor.desde("1.1"))).toString(),
    ).toBe("1.21");
  });

  it("fast-check: redondearSunat coincide con half-up en bigint sobre 4 decimales exactos", () => {
    // oráculo: entero escalado 1e4 → 1e2 con half-up en valor absoluto
    const exacto4 = fc
      .tuple(
        fc.constantFrom("", "-"),
        fc.stringMatching(/^(0|[1-9][0-9]{0,8})$/),
        fc.stringMatching(/^[0-9]{4}$/),
      )
      .map(([s, e, d]) => `${s}${e}.${d}`);
    fc.assert(
      fc.property(exacto4, (s) => {
        const neg = s.startsWith("-");
        const [e, d] = (neg ? s.slice(1) : s).split(".");
        const escalado = BigInt(e + d); // 1e4
        let c = escalado / 100n;
        if (escalado % 100n >= 50n) c += 1n;
        const abs = c.toString().padStart(3, "0");
        let esperado = `${abs.slice(0, -2)}.${abs.slice(-2)}`;
        if (neg && c !== 0n) esperado = `-${esperado}`;
        expect(redondearSunat(exacto(s)).toString()).toBe(esperado);
      }),
      { seed: 20261025, numRuns: 1000 },
    );
  });
});

describe("CA-4 · independiente de la configuración global de Decimal.set", () => {
  const POR = "1.23456789";
  const BASE = "123456.78"; // × 1.23456789 = 152415.7763907942 → 152415.78 (half-up)
  const original = {
    precision: Decimal.precision,
    rounding: Decimal.rounding,
  };

  afterEach(() => {
    Decimal.set({ precision: original.precision, rounding: original.rounding });
    vi.resetModules();
  });

  function calcular(m: typeof import("../index")): {
    grande: string;
    medio: string;
  } {
    return {
      grande: m
        .redondearSunat(m.Money.desde(BASE, "PEN").por(m.Factor.desde(POR)))
        .toString(),
      medio: m.redondearSunat(m.MontoExacto.desde("0.025", "PEN")).toString(),
    };
  }

  it("Decimal.set ANTES de cargar el módulo (ROUND_HALF_EVEN, precision 5) no cambia nada", async () => {
    vi.resetModules();
    Decimal.set({ rounding: Decimal.ROUND_HALF_EVEN, precision: 5 });
    const m = await import("../index");
    const r = calcular(m);
    expect(r.grande).toBe("152415.78");
    expect(r.medio).toBe("0.03");
    // 2.25 × 0.18 = 0.405 sería 0.40 con half-even
    expect(
      m
        .redondearSunat(
          m.Money.desde("2.25", "PEN").por(m.Factor.desde("0.18")),
        )
        .toString(),
    ).toBe("0.41");
  });

  it("Decimal.set DESPUÉS de cargar el módulo no cambia nada", async () => {
    vi.resetModules();
    const m = await import("../index");
    Decimal.set({ rounding: Decimal.ROUND_HALF_EVEN, precision: 5 });
    const r = calcular(m);
    expect(r.grande).toBe("152415.78");
    expect(r.medio).toBe("0.03");
    expect(
      m
        .redondearSunat(
          m.Money.desde("2.25", "PEN").por(m.Factor.desde("0.18")),
        )
        .toString(),
    ).toBe("0.41");
    expect(
      m.Money.desde("0.10", "PEN")
        .sumar(m.Money.desde("0.20", "PEN"))
        .toString(),
    ).toBe("0.30");
  });

  it("Decimal.set con ROUND_DOWN y toExpNeg corto tampoco afecta la salida canónica", async () => {
    vi.resetModules();
    const m = await import("../index");
    Decimal.set({ rounding: Decimal.ROUND_DOWN, toExpNeg: -2, toExpPos: 2 });
    try {
      expect(
        m.redondearSunat(m.MontoExacto.desde("0.0149", "PEN")).toString(),
      ).toBe("0.01");
      expect(
        m.redondearSunat(m.MontoExacto.desde("0.0150", "PEN")).toString(),
      ).toBe("0.02");
      expect(m.Money.desde("1234.50", "PEN").toString()).toBe("1234.50");
      expect(m.Money.desde("0.01", "PEN").toString()).toBe("0.01");
    } finally {
      Decimal.set({ toExpNeg: -7, toExpPos: 21 });
    }
  });
});

describe("CA-3 · producto cuyo redondeo excede el rango", () => {
  const MAX = "999999999999.99";
  it("MAX × 1.01 lanza MontoFueraDeRangoError al redondear", () => {
    expect(() => redondearSunat(pen(MAX).por(Factor.desde("1.01")))).toThrow(
      MontoFueraDeRangoError,
    );
  });
  it("-MAX × 1.01 lanza MontoFueraDeRangoError", () => {
    expect(() =>
      redondearSunat(pen("-" + MAX).por(Factor.desde("1.01"))),
    ).toThrow(MontoFueraDeRangoError);
  });
  it("999999999999.995 redondea a 1 000 000 000 000.00: fuera de rango", () => {
    expect(() => redondearSunat(exacto("999999999999.995"))).toThrow(
      MontoFueraDeRangoError,
    );
    expect(() => redondearSunat(exacto("-999999999999.995"))).toThrow(
      MontoFueraDeRangoError,
    );
  });
  it("999999999999.994 sí cabe (redondea a 999999999999.99)", () => {
    expect(redondearSunat(exacto("999999999999.994")).toString()).toBe(
      "999999999999.99",
    );
  });
  it("MAX × 1 y MAX × 0 son válidos", () => {
    expect(redondearSunat(pen(MAX).por(Factor.desde("1"))).toString()).toBe(
      MAX,
    );
    expect(redondearSunat(pen(MAX).por(Factor.desde("0"))).toString()).toBe(
      "0.00",
    );
  });
});

describe("MontoExacto (hasta 12 enteros y 10 decimales)", () => {
  it("acepta hasta 10 decimales y 12 enteros", () => {
    expect(() =>
      MontoExacto.desde("123456789012.1234567890", "PEN"),
    ).not.toThrow();
    expect(() => MontoExacto.desde("-0.0000000001", "USD")).not.toThrow();
    expect(() => MontoExacto.desde("5", "PEN")).not.toThrow();
  });
  const invalidos: Array<[string, unknown]> = [
    ["11 decimales", "0.12345678901"],
    ["13 enteros", "1234567890123.00"],
    ["number", 1.5],
    ["null", null],
    ["notación científica", "1e-3"],
    ["coma", "1,5"],
    ["espacio", " 1.5"],
    ["vacío", ""],
    ["signo +", "+1.5"],
    ["ceros a la izquierda", "01.5"],
    ["dígitos árabes", "١.٥"],
  ];
  it.each(invalidos)(
    "MontoExacto.desde rechaza %s con MontoInvalidoError",
    (_n, v) => {
      expect(() => MontoExacto.desde(v as unknown as string, "PEN")).toThrow(
        MontoInvalidoError,
      );
    },
  );
  it("conserva la moneda y es inmutable", () => {
    const m = MontoExacto.desde("1.5", "USD");
    expect(m.moneda).toBe("USD");
    expect(Object.isFrozen(m)).toBe(true);
  });
  it("no se serializa sin redondear: toJSON/JSON.stringify lanzan", () => {
    const m = exacto("1.005");
    expect(() => m.toJSON()).toThrow();
    expect(() => JSON.stringify(m)).toThrow();
    expect(() => JSON.stringify({ x: m })).toThrow();
  });
  it("por encadena sin redondear y conserva la moneda", () => {
    const r = MontoExacto.desde("100.00", "USD")
      .por(Factor.desde("0.18"))
      .por(Factor.desde("0.5"));
    expect(r.moneda).toBe("USD");
    expect(redondearSunat(r).toString()).toBe("9.00");
  });
  it("por TipoCambio: 0.15 USD × 3.300 = 0.495 → 0.50 (misma moneda USD)", () => {
    const r = redondearSunat(
      Money.desde("0.15", "USD").por(TipoCambio.desde("3.300")),
    );
    expect(r.toString()).toBe("0.50");
    expect(r.moneda).toBe("USD");
  });
  it("un exacto no puede usarse como Money: no hay sumar", () => {
    expect(
      (exacto("1.5") as unknown as { sumar?: unknown }).sumar,
    ).toBeUndefined();
  });
});

describe("entre (división exacta por Factor, sin redondear)", () => {
  it("10.00 ÷ 4 = 2.5 → 2.50", () => {
    expect(
      redondearSunat(pen("10.00").entre(Factor.desde("4"))).toString(),
    ).toBe("2.50");
  });
  it("1.00 ÷ 3 = 0.333… → 0.33 y 2.00 ÷ 3 = 0.666… → 0.67", () => {
    expect(
      redondearSunat(pen("1.00").entre(Factor.desde("3"))).toString(),
    ).toBe("0.33");
    expect(
      redondearSunat(pen("2.00").entre(Factor.desde("3"))).toString(),
    ).toBe("0.67");
    expect(
      redondearSunat(pen("-2.00").entre(Factor.desde("3"))).toString(),
    ).toBe("-0.67");
  });
  it("igv ÷ 0.18: 1.61 / 0.18 = 8.9444… → 8.94 y 1.60 / 0.18 = 8.8888… → 8.89", () => {
    expect(
      redondearSunat(pen("1.61").entre(Factor.desde("0.18"))).toString(),
    ).toBe("8.94");
    expect(
      redondearSunat(pen("1.60").entre(Factor.desde("0.18"))).toString(),
    ).toBe("8.89");
  });
  it("0.01 ÷ 2 = 0.005 exacto → 0.01 (medio centavo exacto, no falso)", () => {
    expect(
      redondearSunat(pen("0.01").entre(Factor.desde("2"))).toString(),
    ).toBe("0.01");
  });
  it("entre por cero lanza FactorInvalidoError (Money y MontoExacto)", () => {
    expect(() => pen("1.00").entre(Factor.desde("0"))).toThrow(
      FactorInvalidoError,
    );
    expect(() => pen("1.00").entre(Factor.desde("0.0"))).toThrow(
      FactorInvalidoError,
    );
    expect(() => exacto("1.00").entre(Factor.desde("0"))).toThrow(
      FactorInvalidoError,
    );
    expect(() => pen("1.00").entre(Factor.desde("0"))).toThrow(DineroError);
  });
  it("entre y por conservan la moneda y se pueden encadenar", () => {
    const r = Money.desde("9.00", "USD")
      .entre(Factor.desde("3"))
      .por(Factor.desde("2"));
    expect(r.moneda).toBe("USD");
    expect(redondearSunat(r).toString()).toBe("6.00");
  });
  it("(a ÷ f) × f no pierde precisión para f de pocos decimales", () => {
    const f = Factor.desde("0.18");
    expect(redondearSunat(pen("8.97").por(f).entre(f)).toString()).toBe("8.97");
  });
  it("entre sobre un monto que desborda el rango lo detecta al redondear", () => {
    expect(() =>
      redondearSunat(pen("999999999999.99").entre(Factor.desde("0.5"))),
    ).toThrow(MontoFueraDeRangoError);
  });
});

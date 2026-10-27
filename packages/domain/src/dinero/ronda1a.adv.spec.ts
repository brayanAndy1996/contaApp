import Decimal from "decimal.js";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Factor,
  Money,
  MontoExacto,
  MontoFueraDeRangoError,
  MontoInvalidoError,
  redondearSunat,
} from "../index";

// Ronda adversarial 1a (T11a, caja negra): lista mínima de "Ataques obligatorios" de la spec 010.
// Solo API pública (plan 010, Contratos). Cada prueba cita el CA o la D que exige.

const SEMILLA = 20261025;
const CORRIDAS = 1000;
const MAX = "999999999999.99";
const MIN = "-999999999999.99";
const MAX_C = 99999999999999n;
const CANONICO = /^-?\d{1,12}\.\d{2}$/;

const pen = (s: string): Money => Money.desde(s, "PEN");
const exacto = (s: string): MontoExacto => MontoExacto.desde(s, "PEN");

/** Oráculo: céntimos bigint desde string canónico. */
function centimos(s: string): bigint {
  const neg = s.startsWith("-");
  const [ent, dec = ""] = (neg ? s.slice(1) : s).split(".");
  const c = BigInt(ent + dec.padEnd(2, "0"));
  return neg ? -c : c;
}
function desdeCentimos(c: bigint): string {
  const neg = c < 0n;
  const a = (neg ? -c : c).toString().padStart(3, "0");
  return `${neg ? "-" : ""}${a.slice(0, -2)}.${a.slice(-2)}`;
}

describe("ronda 1a · gramática estricta", () => {
  // CA-2, D5, D8 y plan (Gramáticas estrictas): todo esto lanza MontoInvalidoError en desde y desdeNumeric.
  const hostiles: Array<[string, unknown]> = [
    ["1e2", "1e2"],
    ["1E-2", "1E-2"],
    ["coma decimal", "1,00"],
    ["miles con coma", "1,000.00"],
    ["espacio inicial", " 1.00"],
    ["espacio final", "1.00 "],
    ["salto de línea final", "1.00\n"],
    ["salto de línea inicial", "\n1.00"],
    ["tab", "1.00\t"],
    ["+", "+1.00"],
    ["cero a la izquierda", "01.00"],
    ["doble cero", "00.00"],
    ["-00", "-00.00"],
    [".5", ".5"],
    ["5.", "5."],
    ["-.5", "-.5"],
    ["3 decimales", "1.000"],
    ["13 enteros", "1000000000000.00"],
    ["separador _", "1_000.00"],
    ["doble punto", "1..0"],
    ["dos puntos", "1.0.0"],
    ["solo -", "-"],
    ["solo .", "."],
    ["--1", "--1"],
    ["0x10", "0x10"],
    ["0b1", "0b1"],
    ["texto Infinity", "Infinity"],
    ["texto NaN", "NaN"],
    ["dígitos árabes", "١٢.٠٠"],
    ["dígitos persas", "۱۲.۰۰"],
    ["dígitos de ancho completo", "１２.００"],
    ["NBSP inicial", " 12.00"],
    ["NBSP como miles", "1 000.00"],
    ["espacio fino", "1 000.00"],
    ["zero-width", "​1.00"],
    ["BOM", "﻿1.00"],
    ["signo menos Unicode", "−1.00"],
    ["guion de ancho completo", "－1.00"],
    ["NUL final", "1.00\u0000"],
    ["string enorme", "1".repeat(100000)],
    ["number 12.5", 12.5],
    ["number entero", 1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["-0 number", -0],
    ["bigint", 1n],
    ["boolean", true],
    ["null", null],
    ["undefined", undefined],
    ["arreglo con toString canónico", ["1.00"]],
    ["new String", new String("1.00")],
    ["objeto con toString", { toString: () => "1.00" }],
    ["objeto con valueOf", { valueOf: () => "1.00" }],
    ["Symbol", Symbol("1.00")],
  ];

  it.each(hostiles)("rechaza %s con MontoInvalidoError", (_n, valor) => {
    const v = valor as unknown as string;
    expect(() => Money.desde(v, "PEN")).toThrow(MontoInvalidoError);
    expect(() => Money.desdeNumeric(v, "PEN")).toThrow(MontoInvalidoError);
  });
});

describe("ronda 1a · límites de NUMERIC(14,2) y sumas largas", () => {
  it("desborda solo fuera de ±999 999 999 999.99 y suma es invariante ante el orden aun con extremos (CA-3, CA-6)", () => {
    // CA-3: bordes exactos.
    expect(() => pen(MAX).sumar(pen("0.01"))).toThrow(MontoFueraDeRangoError);
    expect(() => pen(MIN).restar(pen("0.01"))).toThrow(MontoFueraDeRangoError);
    expect(pen(MIN).negar().toString()).toBe(MAX);
    expect(pen(MIN).abs().toString()).toBe(MAX);
    expect(pen(MAX).sumar(pen(MIN)).esCero()).toBe(true);
    // CA-3: producto o cociente cuyo redondeo excede el rango.
    expect(() => redondearSunat(exacto("999999999999.995"))).toThrow(
      MontoFueraDeRangoError,
    );
    expect(() => redondearSunat(exacto("-999999999999.995"))).toThrow(
      MontoFueraDeRangoError,
    );
    expect(redondearSunat(exacto("999999999999.9949999999")).toString()).toBe(
      MAX,
    );
    expect(() =>
      redondearSunat(pen(MAX).por(Factor.desde("1.0000000001"))),
    ).toThrow(MontoFueraDeRangoError);
    expect(() =>
      redondearSunat(pen(MAX).entre(Factor.desde("0.9999999999"))),
    ).toThrow(MontoFueraDeRangoError);
    // Suma larga: 1000 × 999 999 999.99 cabe; un sumando más la desborda.
    const mil = Array.from({ length: 1000 }, () => pen("999999999.99"));
    expect(Money.suma(mil, "PEN").toString()).toBe("999999999990.00");
    expect(() => Money.suma([...mil, pen("10.00")], "PEN")).toThrow(
      MontoFueraDeRangoError,
    );

    // CA-6: la suma da lo mismo en cualquier permutación, también cuando un orden pasa por un
    // parcial fuera de rango y otro no (p. ej. [MAX, 0.01, −0.01] vs [MAX, −0.01, 0.01]).
    const extremo = fc.constantFrom(
      MAX,
      MIN,
      "0.01",
      "-0.01",
      "500000000000.00",
      "-500000000000.00",
    );
    const libre = fc.bigInt({ min: -MAX_C, max: MAX_C }).map(desdeCentimos);
    const lista = fc.array(fc.oneof(extremo, libre), {
      minLength: 1,
      maxLength: 8,
    });
    const resultado = (xs: string[]): string => {
      try {
        return Money.suma(xs.map(pen), "PEN").toString();
      } catch (e) {
        if (e instanceof MontoFueraDeRangoError) return "FUERA";
        throw e;
      }
    };
    fc.assert(
      fc.property(lista, fc.infiniteStream(fc.nat()), (xs, azar) => {
        const t = xs.reduce((a, s) => a + centimos(s), 0n);
        const esperado = t > MAX_C || t < -MAX_C ? "FUERA" : desdeCentimos(t);
        const mezcla = [...xs]
          .map((s) => [azar.next().value, s] as const)
          .sort((a, b) => a[0] - b[0])
          .map(([, s]) => s);
        const ordenes = [
          xs,
          [...xs].reverse(),
          [...xs].sort((a, b) => (centimos(a) < centimos(b) ? -1 : 1)),
          [...xs].sort((a, b) => (centimos(a) > centimos(b) ? -1 : 1)),
          mezcla,
        ];
        for (const o of ordenes) expect(resultado(o)).toBe(esperado);
      }),
      { seed: SEMILLA, numRuns: CORRIDAS },
    );
  });
});

describe("ronda 1a · medio centavo y cero negativo", () => {
  // CA-4 y D1 (half-up alejándose de cero) en ambos signos; CA-5 y Alcance (sin "-0.00").
  const casos: Array<[string, () => Money, string]> = [
    ["0.005", () => redondearSunat(exacto("0.005")), "0.01"],
    ["0.015", () => redondearSunat(exacto("0.015")), "0.02"],
    ["0.025", () => redondearSunat(exacto("0.025")), "0.03"],
    ["0.035", () => redondearSunat(exacto("0.035")), "0.04"],
    ["0.045", () => redondearSunat(exacto("0.045")), "0.05"],
    ["1.005", () => redondearSunat(exacto("1.005")), "1.01"],
    ["2.675 (trampa de float)", () => redondearSunat(exacto("2.675")), "2.68"],
    ["1.125", () => redondearSunat(exacto("1.125")), "1.13"],
    ["-0.005", () => redondearSunat(exacto("-0.005")), "-0.01"],
    ["-0.015", () => redondearSunat(exacto("-0.015")), "-0.02"],
    ["-0.025", () => redondearSunat(exacto("-0.025")), "-0.03"],
    ["-2.675", () => redondearSunat(exacto("-2.675")), "-2.68"],
    ["0.0049999999", () => redondearSunat(exacto("0.0049999999")), "0.00"],
    ["0.0050000001", () => redondearSunat(exacto("0.0050000001")), "0.01"],
    [
      "-0.0049999999 → sin -0.00",
      () => redondearSunat(exacto("-0.0049999999")),
      "0.00",
    ],
    [
      "-0.0000000001 → sin -0.00",
      () => redondearSunat(exacto("-0.0000000001")),
      "0.00",
    ],
    [
      "-999999999999.985",
      () => redondearSunat(exacto("-999999999999.985")),
      MIN,
    ],
    [
      "0.01 × 0.5 = 0.005",
      () => redondearSunat(pen("0.01").por(Factor.desde("0.5"))),
      "0.01",
    ],
    [
      "-0.01 × 0.5 = -0.005",
      () => redondearSunat(pen("-0.01").por(Factor.desde("0.5"))),
      "-0.01",
    ],
    [
      "-0.01 × 0.4 → sin -0.00",
      () => redondearSunat(pen("-0.01").por(Factor.desde("0.4"))),
      "0.00",
    ],
    [
      "-2.25 × 0.18",
      () => redondearSunat(pen("-2.25").por(Factor.desde("0.18"))),
      "-0.41",
    ],
    [
      "0.01 ÷ 2",
      () => redondearSunat(pen("0.01").entre(Factor.desde("2"))),
      "0.01",
    ],
    [
      "-0.01 ÷ 2",
      () => redondearSunat(pen("-0.01").entre(Factor.desde("2"))),
      "-0.01",
    ],
    ["Money '-0'", () => pen("-0"), "0.00"],
    ["Money '-0.0'", () => pen("-0.0"), "0.00"],
    ["Money '-0.00'", () => pen("-0.00"), "0.00"],
    ["desdeNumeric '-0.00'", () => Money.desdeNumeric("-0.00", "PEN"), "0.00"],
    ["negar(0.00)", () => pen("0.00").negar(), "0.00"],
    ["negar(-0.00)", () => pen("-0.00").negar(), "0.00"],
    ["abs(-0.00)", () => pen("-0.00").abs(), "0.00"],
    ["0.01 − 0.01", () => pen("0.01").restar(pen("0.01")), "0.00"],
    ["-0.01 + 0.01", () => pen("-0.01").sumar(pen("0.01")), "0.00"],
    ["suma [] ", () => Money.suma([], "PEN"), "0.00"],
  ];

  it.each(casos)(
    "%s → canónico, y cero ⇔ esCero sin signo",
    (_n, f, esperado) => {
      const m = f();
      expect(m.toString()).toBe(esperado);
      expect(`${m}`).toBe(esperado);
      expect(m.toJSON().monto).toBe(esperado);
      const esCero = esperado === "0.00";
      expect(m.esCero()).toBe(esCero);
      expect(m.igual(Money.cero("PEN"))).toBe(esCero);
      expect(m.comparar(Money.cero("PEN")) === 0).toBe(esCero);
      expect(m.esNegativo()).toBe(esperado.startsWith("-"));
    },
  );
});

describe("ronda 1a · Decimal.set global alterado por otro módulo", () => {
  afterEach(() => {
    Decimal.set({ defaults: true });
    vi.resetModules();
  });

  it("ni antes ni después de cargar el módulo cambia redondeo, precisión ni formato (CA-4, plan decimal.js aislado)", async () => {
    // Configuración global hostil ANTES de cargar @contapp/domain.
    Decimal.set({
      rounding: Decimal.ROUND_DOWN,
      precision: 2,
      toExpNeg: -1,
      toExpPos: 1,
      minE: -3,
      maxE: 3,
    });
    vi.resetModules();
    const api = await import("../index.js");
    const p = (s: string) => api.Money.desde(s, "PEN");
    const r = (s: string) =>
      api.redondearSunat(api.MontoExacto.desde(s, "PEN")).toString();

    const comprobar = (): void => {
      expect(r("0.005")).toBe("0.01");
      expect(r("-0.005")).toBe("-0.01");
      expect(r("0.015")).toBe("0.02");
      expect(r("-0.0049999999")).toBe("0.00");
      expect(
        api.redondearSunat(p("2.25").por(api.Factor.desde("0.18"))).toString(),
      ).toBe("0.41");
      expect(
        api.redondearSunat(p("2.00").entre(api.Factor.desde("3"))).toString(),
      ).toBe("0.67");
      expect(p("0.10").toString()).toBe("0.10");
      expect(p("123456789012.34").toString()).toBe("123456789012.34");
      expect(p("999999999999.99").restar(p("0.01")).toString()).toBe(
        "999999999999.98",
      );
      expect(p("0.10").sumar(p("0.20")).toString()).toBe("0.30");
      expect(() => p("999999999999.99").sumar(p("0.01"))).toThrow(
        api.MontoFueraDeRangoError,
      );
    };
    comprobar();

    // Y DESPUÉS de cargado, otro módulo cambia la configuración otra vez.
    Decimal.set({
      rounding: Decimal.ROUND_HALF_EVEN,
      precision: 1,
      toExpNeg: 0,
      toExpPos: 0,
    });
    comprobar();
  });
});

describe("ronda 1a · ida y vuelta NUMERIC(14,2) y JSON", () => {
  it("desdeNumeric/toString/JSON son idempotentes, sin number, y desdeJSON es estricto (Alcance, CA-11, plan Contratos)", () => {
    const formaPg = fc
      .tuple(fc.bigInt({ min: -MAX_C, max: MAX_C }), fc.constantFrom(0, 1, 2))
      .map(([c, dec]) => {
        const can = desdeCentimos(c);
        // NUMERIC puede llegar con 0, 1 o 2 decimales si viene de un cast; la normal es 2.
        const s =
          dec === 0 && can.endsWith(".00")
            ? can.slice(0, -3)
            : dec === 1 && can.endsWith("0")
              ? can.slice(0, -1)
              : can;
        return [s, can] as const;
      });
    fc.assert(
      fc.property(
        formaPg,
        fc.constantFrom("PEN" as const, "USD" as const),
        ([s, can], moneda) => {
          const m = Money.desdeNumeric(s, moneda);
          expect(m.toString()).toBe(can);
          expect(m.toString()).toMatch(CANONICO);
          expect(Money.desdeNumeric(m.toString(), moneda).toString()).toBe(can);
          const json = JSON.stringify(m);
          expect(json).not.toMatch(/:\s*-?\d/); // ningún number en el JSON
          const vuelta = Money.desdeJSON(JSON.parse(json));
          expect(vuelta.igual(m)).toBe(true);
          expect(vuelta.moneda).toBe(moneda);
          expect(JSON.stringify(vuelta)).toBe(json);
        },
      ),
      { seed: SEMILLA, numRuns: CORRIDAS },
    );

    // MontoExacto no se serializa sin redondear.
    expect(() =>
      JSON.stringify(pen("1.00").por(Factor.desde("0.18"))),
    ).toThrow();

    // desdeJSON estricto: monto string canónico, moneda PEN/USD, sin claves extra.
    const malos: unknown[] = [
      null,
      undefined,
      "1.00",
      ["1.00", "PEN"],
      { monto: 1.5, moneda: "PEN" },
      { monto: "1e2", moneda: "PEN" },
      { monto: "1,00", moneda: "PEN" },
      { monto: "1.00", moneda: "EUR" },
      { monto: "1.00", moneda: "pen" },
      { monto: "1.00" },
      { moneda: "PEN" },
      { monto: "1.00", moneda: "PEN", extra: 1 },
      JSON.parse('{"monto":"1.00","moneda":"PEN","__proto__":{"x":1}}'),
      { monto: { toString: () => "1.00" }, moneda: "PEN" },
    ];
    for (const j of malos) expect(() => Money.desdeJSON(j)).toThrow();
  });
});

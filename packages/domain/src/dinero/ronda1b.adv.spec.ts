// T11b · Ronda adversarial 1b (caja blanca), spec 010. Solo escenarios fuera de la lista de T11a.
// Cada prueba afirma el comportamiento seguro que exige un CA o una D (citado en el nombre).
import { Decimal } from "decimal.js";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import * as Publico from "../index";
import {
  Factor,
  Money,
  MontoExacto,
  MontosComprobante,
  TipoCambio,
  Tolerancia,
  redondearSunat,
} from "../index";

type Dominio = typeof Publico;
type Ctor = new (...a: unknown[]) => unknown;

const SEMILLA = 20261025;

/** Céntimos → string canónico de Money. */
function aTexto(c: bigint): string {
  const neg = c < 0n;
  const a = neg ? -c : c;
  const s = `${a / 100n}.${(a % 100n).toString().padStart(2, "0")}`;
  return neg && a !== 0n ? `-${s}` : s;
}

const arbMonto = fc.bigInt({ min: -99999999999999n, max: 99999999999999n }).map(aTexto);

/** Factor canónico > 0: ^(0|[1-9][0-9]{0,5})(\.[0-9]{1,10})?$ */
const arbFactorPositivo = fc
  .tuple(fc.bigInt({ min: 0n, max: 999999n }), fc.integer({ min: 0, max: 10 }), fc.bigInt({ min: 0n, max: 9999999999n }))
  .map(([ent, largo, frac]) => {
    if (largo === 0) return `${ent}`;
    const f = (frac % 10n ** BigInt(largo)).toString().padStart(largo, "0");
    return `${ent}.${f}`;
  })
  .filter((s) => /[1-9]/.test(s));

describe("T11b · dinero (ronda 1b)", () => {
  it("R1b-1 · con Decimal.set hostil ANTES de cargar el módulo (clone sin heredar), por/entre/redondearSunat son idempotentes, hacen ida y vuelta y respetan el límite a 1 ulp (D1, CA-3, CA-4; plan: decimal.js aislado)", async () => {
    const guardado = {
      precision: Decimal.precision,
      rounding: Decimal.rounding,
      toExpNeg: Decimal.toExpNeg,
      toExpPos: Decimal.toExpPos,
      minE: Decimal.minE,
      maxE: Decimal.maxE,
      modulo: Decimal.modulo,
    };
    Decimal.set({
      precision: 2,
      rounding: Decimal.ROUND_DOWN,
      toExpNeg: -1,
      toExpPos: 1,
      minE: -3,
      maxE: 3,
      modulo: Decimal.EUCLID,
    });
    vi.resetModules();
    try {
      const d: Dominio = await import("../index.js");
      const M = (s: string) => d.Money.desde(s, "PEN");
      const F = (s: string) => d.Factor.desde(s);
      const X = (s: string) => d.MontoExacto.desde(s, "PEN");
      const r = (x: Publico.MontoExacto) => d.redondearSunat(x).toString();

      // CA-4 y serialización sin exponente con la configuración global alterada antes de cargar.
      expect(r(M("2.25").por(d.TASA_IGV_18))).toBe("0.41");
      expect(r(M("-2.25").por(d.TASA_IGV_18))).toBe("-0.41");
      expect(M("999999999999.99").toString()).toBe("999999999999.99");
      expect(X("0.0000000001").toString()).toBe("0.0000000001");

      // CA-3 a 1 ulp del límite tras entre/por.
      expect(r(X("499999999999.997").entre(F("0.5")))).toBe("999999999999.99");
      expect(() => r(X("499999999999.9975").entre(F("0.5")))).toThrow(d.MontoFueraDeRangoError);
      expect(r(X("-499999999999.997").entre(F("0.5")))).toBe("-999999999999.99");
      expect(() => r(X("-499999999999.9975").entre(F("0.5")))).toThrow(d.MontoFueraDeRangoError);
      expect(() => r(M("999999999999.99").por(F("1.0000000001")))).toThrow(d.MontoFueraDeRangoError);
      expect(r(M("-999999999999.99").entre(F("1")))).toBe("-999999999999.99");

      // Ida y vuelta e idempotencia (propiedad, semilla fija).
      fc.assert(
        fc.property(arbMonto, arbFactorPositivo, (s, fs) => {
          const m = M(s);
          const f = F(fs);
          expect(r(m.por(f).entre(f))).toBe(m.toString());
          expect(r(m.entre(f).por(f))).toBe(m.toString());
          const igv = d.redondearSunat(m.por(d.TASA_IGV_18));
          expect(r(X(igv.toString()))).toBe(igv.toString());
          expect(r(igv.por(F("1")))).toBe(igv.toString());
          expect(r(igv.entre(F("1")))).toBe(igv.toString());
        }),
        { seed: SEMILLA, numRuns: 1000 },
      );

      // Cadena larga: 200 vueltas de ×1.18 ÷3e-10 ÷1.18 ×3e-10 no acumulan pérdida visible.
      let x = M("123456789.01").por(F("1"));
      for (let i = 0; i < 200; i++) {
        x = x.por(F("1.18")).entre(F("0.0000000003")).entre(F("1.18")).por(F("0.0000000003"));
      }
      expect(r(x)).toBe("123456789.01");
    } finally {
      Decimal.set(guardado);
      vi.resetModules();
    }
  });

  // El plan (Precisión) afirma que redondear a 40 dígitos y luego a 2 no altera el resultado.
  // En cadenas entre → por el valor exacto puede ser un medio céntimo (0.055) y el truncamiento
  // de la división lo deja en 0.0549999…: D1 exige half-up (0.055 → 0.06).
  it.each<[string, string, string, string]>([
    ["0.02", "0.18", "0.495", "0.06"], // igv / 0.18 × 0.495 = 0.055 exacto
    ["-0.02", "0.18", "0.495", "-0.06"],
    ["0.01", "3.3", "18.15", "0.06"], // 0.01 / 3.3 × 18.15 = 0.055 exacto
    ["0.01", "3", "TC 16.5", "0.06"], // ÷ 3 y luego × TipoCambio 16.5 = 0.055 exacto
  ])(
    "R1b-2 · %s ÷ %s × %s es un medio céntimo exacto y redondearSunat da %s (D1, CA-4)",
    (m, divisor, mult, esperado) => {
      const q = Money.desde(m, "PEN").entre(Factor.desde(divisor));
      const x = mult.startsWith("TC ")
        ? q.por(TipoCambio.desde(mult.slice(3)))
        : q.por(Factor.desde(mult));
      expect(redondearSunat(x).toString()).toBe(esperado);
    },
  );

  // Los constructores son `private` solo para TypeScript: en ejecución `new (Clase as …)(…)`
  // crea instancias saltándose gramática, moneda y signo. Un Money de 0.001 imprime "0.00"
  // pero diez de ellos suman "0.01" (monto incorrecto); un TipoCambio negativo pasa D7.
  it.each<[string, () => unknown]>([
    ["Money con Decimal de 3 decimales (D8)", () => new (Money as unknown as Ctor)(new Decimal("0.001"), "PEN")],
    ["Money con moneda EUR (D7)", () => new (Money as unknown as Ctor)(new Decimal("1"), "EUR")],
    ["MontoExacto con moneda EUR (D7)", () => new (MontoExacto as unknown as Ctor)(new Decimal("1"), "EUR")],
    ["TipoCambio negativo (D7, CA-13)", () => new (TipoCambio as unknown as Ctor)(new Decimal("-3.3"))],
    ["Factor negativo (plan: gramática sin signo)", () => new (Factor as unknown as Ctor)(new Decimal("-0.18"))],
    ["Tolerancia negativa (plan: ≥ 0)", () => new (Tolerancia as unknown as Ctor)(new Decimal("-1"))],
    [
      "MontosComprobante PEN con columna USD y columnas faltantes (CA-7)",
      () =>
        new (MontosComprobante as unknown as Ctor)(
          "PEN",
          { biDg: Money.desde("1.00", "USD") },
          Money.desde("1.00", "PEN"),
        ),
    ],
  ])("R1b-3 · constructor privado inalcanzable en ejecución: %s", (_nombre, crear) => {
    expect(crear).toThrow();
  });
});

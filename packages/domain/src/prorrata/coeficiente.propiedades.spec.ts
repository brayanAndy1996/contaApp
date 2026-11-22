// Spec 026 · T1 (rojo). Propiedades de calcularProrrata contra un oráculo con BigInt en céntimos (CA-2, R-3, R-4, R-6, U-7).
// El oráculo no reutiliza nada del dominio de prorrata ni de dinero/: porcentaje en centésimas = round_half_up(numerador × 10000 / total).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { SEMILLA } from "../../tests/ayudas/comprobante";
import {
  VENTANA_202610 as V,
  aTexto,
  mesDeclarado,
  mesFalta,
  mesManual,
  mesSire,
} from "../../tests/ayudas/prorrata";
import { calcularProrrata } from "./coeficiente";

type Origen = "declarado" | "manual" | "sire" | "falta";
interface MesGen {
  origen: Origen;
  g: bigint;
  e: bigint;
  n: bigint;
}

const cent = (min: number, max: number) => fc.integer({ min, max }).map((x) => BigInt(x));
// Valores chicos y negativos en proporción para tocar todos los estados (calculado, total 0, acumulado inválido).
const gArb = fc.oneof({ weight: 6, arbitrary: cent(0, 5_000_000) }, { weight: 2, arbitrary: cent(-20_000, 0) }, { weight: 2, arbitrary: fc.constant(0n) });
const eArb = fc.oneof({ weight: 6, arbitrary: fc.constant(0n) }, { weight: 3, arbitrary: cent(0, 3_000_000) }, { weight: 1, arbitrary: cent(-5_000, 0) });
const nArb = fc.oneof({ weight: 6, arbitrary: cent(0, 5_000_000) }, { weight: 2, arbitrary: cent(-20_000, 0) }, { weight: 2, arbitrary: fc.constant(0n) });
const origenArb = fc.oneof(
  { weight: 5, arbitrary: fc.constant<Origen>("declarado") },
  { weight: 3, arbitrary: fc.constant<Origen>("manual") },
  { weight: 2, arbitrary: fc.constant<Origen>("sire") },
  { weight: 1, arbitrary: fc.constant<Origen>("falta") },
);
const mesGenArb = fc.record({ origen: origenArb, g: gArb, e: eArb, n: nArb });
// Un caso sin faltantes (para ejercitar el cálculo) y uno general con faltantes ocasionales.
const sinFaltaArb = fc.array(mesGenArb.filter((m) => m.origen !== "falta"), { minLength: 12, maxLength: 12 });
const generalArb = fc.array(mesGenArb, { minLength: 12, maxLength: 12 });

/** Valores efectivos del mes: un mes SIRE no trae exportaciones (R-2b). */
const efectivo = (m: MesGen) => ({ g: m.g, e: m.origen === "sire" ? 0n : m.e, n: m.n });

function armar(gen: MesGen[]) {
  return gen.map((m, i) => {
    const [g, e, n] = [aTexto(m.g), aTexto(m.e), aTexto(m.n)];
    switch (m.origen) {
      case "declarado":
        return mesDeclarado(V[i], g, e, n);
      case "manual":
        return mesManual(V[i], g, e, n);
      case "sire":
        return mesSire(V[i], g, n);
      default:
        return mesFalta(V[i]);
    }
  });
}

function oraculo(gen: MesGen[]) {
  const faltantes = gen.flatMap((m, i) => (m.origen === "falta" ? [V[i]] : []));
  if (faltantes.length > 0) return { estado: "faltan_meses" as const, faltantes };
  let num = 0n;
  let nog = 0n;
  for (const m of gen) {
    const x = efectivo(m);
    num += x.g + x.e;
    nog += x.n;
  }
  const total = num + nog;
  if (total === 0n && num === 0n) return { estado: "no_determinable" as const, motivo: "total_cero" as const };
  if (num < 0n || total <= 0n || num > total) {
    // total 0 con numerador ≠ 0 es ambiguo entre `total_cero` y `acumulado_invalido` (spec R-4): solo se exige el estado.
    return total === 0n
      ? { estado: "no_determinable" as const, motivo: null }
      : { estado: "no_determinable" as const, motivo: "acumulado_invalido" as const };
  }
  const c = (2n * num * 10000n + total) / (2n * total);
  const sire = gen.some((m) => m.origen === "sire");
  const expEnOtros = gen.some((m) => (m.origen === "declarado" || m.origen === "manual") && m.e !== 0n);
  return {
    estado: "calculado" as const,
    porcentaje: `${c / 100n}.${(c % 100n).toString().padStart(2, "0")}`,
    numerador: aTexto(num),
    total: aTexto(total),
    provisional: gen.some((m) => m.origen === "sire" || m.origen === "manual"),
    avisos: [...(num === 0n ? ["numerador_cero"] : []), ...(sire && expEnOtros ? ["exportaciones_en_sire"] : [])].sort(),
  };
}

function verificar(gen: MesGen[]) {
  const r = calcularProrrata(armar(gen));
  const o = oraculo(gen);
  expect(r.estado).toBe(o.estado);
  if (o.estado === "faltan_meses") {
    expect(r).toEqual({ estado: "faltan_meses", faltantes: o.faltantes });
  } else if (o.estado === "no_determinable") {
    expect(r).toMatchObject({ estado: "no_determinable" });
    if (o.motivo !== null) expect(r).toEqual({ estado: "no_determinable", motivo: o.motivo });
  } else if (r.estado === "calculado") {
    expect(String(r.porcentaje)).toBe(o.porcentaje);
    expect(String(r.numerador)).toBe(o.numerador);
    expect(String(r.total)).toBe(o.total);
    expect(r.provisional).toBe(o.provisional);
    expect([...r.avisos].sort()).toEqual(o.avisos);
  }
}

describe("calcularProrrata: propiedades contra el oráculo en céntimos (10.000 casos)", () => {
  it("sin meses faltantes: estado, porcentaje, numerador, total, provisional y avisos coinciden", () => {
    fc.assert(fc.property(sinFaltaArb, verificar), { numRuns: 10_000, seed: SEMILLA });
  });

  it("con faltantes ocasionales: faltan_meses lista exactamente los meses sin origen y, si no hay, coincide el cálculo", () => {
    fc.assert(fc.property(generalArb, verificar), { numRuns: 10_000, seed: SEMILLA + 1 });
  });

  it("el porcentaje calculado siempre está entre 0.00 y 100.00 con 2 decimales", () => {
    fc.assert(
      fc.property(sinFaltaArb, (gen) => {
        const r = calcularProrrata(armar(gen));
        if (r.estado === "calculado") {
          const p = String(r.porcentaje);
          expect(p).toMatch(/^(100|[0-9]{1,2})\.[0-9]{2}$/);
          expect(BigInt(p.replace(".", "")) <= 10000n).toBe(true);
        }
      }),
      { numRuns: 10_000, seed: SEMILLA + 2 },
    );
  });
});

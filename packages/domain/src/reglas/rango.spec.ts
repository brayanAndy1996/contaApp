// T4 (rojo): rango del gravado de R-MIX (CA-4) y precedencia de R-ISC / R-MIX por destino (CA-5)
// vía evaluarReglas/aplicarSugerencia. El oráculo usa centavos enteros (independiente de la implementación).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { NUM_RUNS, SEMILLA, centavosAString } from "../../tests/ayudas/comprobante";
import { ctxBase, de, evaluar, fila, pen, sug, unico } from "../../tests/ayudas/filas";
import { ConfirmacionInvalidaError, aplicarSugerencia } from "./index";
import type { FilaEvaluable } from "./index";

/** Entorno con el que se evaluó el hallazgo (T15b-1). */
const ent = (filas: FilaEvaluable[], contexto = ctxBase()) => ({ filas, contexto });

// ---------------------------------------------------------------- oráculo (centavos enteros)
/** igvEsperado en centavos: redondeo half-up de base × pct / 100 (la base ≥ 0). */
const esperado = (base: number, pct: number): number => Math.floor((pct * base + 50) / 100);
const cuadra = (bi: number, igv: number, pct: number): boolean => Math.abs(igv - esperado(bi, pct)) <= 1;
const dispara = (bi: number, igv: number): boolean => !cuadra(bi, igv, 18) && !cuadra(bi, igv, 10);

/** Rango {g | esperado(g, 18) = igv} ∩ [1, bi] en forma cerrada; null si es vacío. */
function rangoOraculo(bi: number, igv: number): { lo: number; hi: number; estimado: number } | null {
  const lo = Math.max(1, Math.ceil((100 * igv - 50) / 18));
  const hi = Math.min(bi, Math.floor((100 * igv + 49) / 18));
  if (lo > hi) return null;
  const e = Math.floor((100 * igv + 9) / 18); // redondearSunat(IGV / 0.18); sin empates posibles
  return { lo, hi, estimado: Math.min(hi, Math.max(lo, e)) };
}

describe("oráculo de centavos (verde: valida el oráculo contra fuerza bruta)", () => {
  it("la forma cerrada coincide con la búsqueda exhaustiva", () => {
    for (const bi of [1, 2, 5, 8, 9, 17, 100, 555, 2148]) {
      for (let igv = 1; igv <= 400; igv++) {
        const bruto: number[] = [];
        for (let g = 1; g <= bi; g++) if (esperado(g, 18) === igv) bruto.push(g);
        const r = rangoOraculo(bi, igv);
        if (bruto.length === 0) expect(r).toBeNull();
        else {
          expect(r).not.toBeNull();
          expect([r!.lo, r!.hi]).toEqual([bruto[0], bruto[bruto.length - 1]]);
          expect(bruto.length).toBe(r!.hi - r!.lo + 1);
        }
      }
    }
  });
});

// ---------------------------------------------------------------- casos fijos del rango
describe("rango del gravado: casos fijos (CA-4, D-3)", () => {
  it.each([
    ["21.48", "1.61", "8.92", "8.97", "8.94"],
    ["21.48", "1.60", "8.87", "8.91", "8.89"], // 1 céntimo por debajo del IGV de la mixta
    ["21.48", "0.01", "0.03", "0.08", "0.06"],
    ["80.00", "5.00", "27.75", "27.80", "27.78"],
    ["1000.00", "1.00", "5.53", "5.58", "5.56"],
  ])("BI %s IGV %s: rango %s–%s, estimado %s", (bi, igv, min, max, est) => {
    const h = unico(evaluar([fila({ biDg: bi, igvDg: igv })]).hallazgos, "R-MIX");
    const s = sug(h, "separar");
    expect([s.min.toString(), s.max.toString(), s.estimado.toString()]).toEqual([min, max, est]);
    expect(s.exacto).toBeNull();
  });

  it.each([
    ["0.00", "1.00"], // BI 0 con IGV > 0
    ["5.00", "1.00"], // el gravado necesario (5.53–5.58) excede la BI
    ["10.00", "3.00"], // IGV mayor que el 18 % de la BI
    ["10.00", "20.00"], // IGV mayor que la BI
  ])("BI %s IGV %s: rango vacío, hallazgo sin sugerencia", (bi, igv) => {
    const h = unico(evaluar([fila({ biDg: bi, igvDg: igv })]).hallazgos, "R-MIX");
    expect(h.sugerencia).toBeNull();
  });

  it("el estimado queda dentro del rango y aplicar con min, estimado y max conserva el total", () => {
    const f = fila({ biDg: "1000.00", igvDg: "1.00" });
    const h = unico(evaluar([f]).hallazgos, "R-MIX");
    const s = sug(h, "separar");
    for (const g of [s.min, s.estimado, s.max]) {
      const r = aplicarSugerencia(f.montos, h, { gravado: g }, ent([f])).montos;
      expect(r.total.toString()).toBe("1001.00");
      expect(r.obtener("biDg").toString()).toBe(g.toString());
    }
  });
});

// ---------------------------------------------------------------- CA-4 como propiedad
describe("rango del gravado: propiedad con oráculo de centavos (CA-4)", () => {
  const arbBi = fc.oneof(
    { weight: 2, arbitrary: fc.integer({ min: 1, max: 60 }) },
    { weight: 3, arbitrary: fc.integer({ min: 1, max: 100_000_000 }) },
  );
  const arbCaso = arbBi.chain((bi) =>
    fc.record({
      bi: fc.constant(bi),
      igv: fc.oneof(
        fc.integer({ min: 1, max: Math.ceil(bi * 0.2) + 5 }),
        fc
          .tuple(fc.integer({ min: 1, max: bi }), fc.integer({ min: -2, max: 2 }))
          .map(([g, d]) => Math.max(1, esperado(g, 18) + d)),
      ),
      nota: fc.boolean(),
    }),
  );

  it("para todo IGV y BI: dispara según el oráculo, el rango coincide y min−0.01 / max+0.01 no cumplen", () => {
    fc.assert(
      fc.property(arbCaso, ({ bi, igv, nota }) => {
        const s = nota ? -1 : 1;
        const f = fila({ biDg: centavosAString(s * bi), igvDg: centavosAString(s * igv) });
        const mix = de(evaluar([f]).hallazgos, "R-MIX");
        if (!dispara(bi, igv)) {
          expect(mix).toHaveLength(0);
          return;
        }
        expect(mix).toHaveLength(1);
        const h = mix[0]!;
        const esperadoRango = rangoOraculo(bi, igv);
        if (esperadoRango === null) {
          expect(h.sugerencia).toBeNull();
          return;
        }
        const { lo, hi, estimado } = esperadoRango;
        // Cada g del rango cumple igvEsperado(g, 18 %) = IGV y 0 < g ≤ BI; los vecinos no.
        expect(esperado(lo, 18)).toBe(igv);
        expect(esperado(hi, 18)).toBe(igv);
        expect(lo === 1 || esperado(lo - 1, 18) !== igv).toBe(true);
        expect(hi === bi || esperado(hi + 1, 18) !== igv).toBe(true);

        const sg = sug(h, "separar");
        const [a, b] = [sg.min.abs(), sg.max.abs()].sort((x, y) => x.comparar(y));
        expect(a!.toString()).toBe(centavosAString(lo));
        expect(b!.toString()).toBe(centavosAString(hi));
        expect(sg.estimado.abs().toString()).toBe(centavosAString(estimado));
        expect(sg.estimado.esNegativo()).toBe(nota);
        expect(sg.exacto).toBeNull();
        expect(h.requiereConfirmacion).toBe(true);
        expect(h.dato).toBe("gravado");

        // Aplicar: acepta lo, estimado y hi; rechaza lo−1 y hi+1; conserva el total.
        for (const g of [lo, estimado, hi]) {
          const r = aplicarSugerencia(f.montos, h, { gravado: pen(centavosAString(s * g)) }, ent([f])).montos;
          expect(r.obtener("biDg").toString()).toBe(centavosAString(s * g));
          expect(r.obtener("noGravado").toString()).toBe(centavosAString(s * (bi - g)));
          expect(r.obtener("igvDg").toString()).toBe(centavosAString(s * igv));
          expect(r.total.toString()).toBe(f.montos.total.toString());
        }
        for (const g of [lo - 1, hi + 1]) {
          expect(() => aplicarSugerencia(f.montos, h, { gravado: pen(centavosAString(s * g)) }, ent([f]))).toThrow(
            ConfirmacionInvalidaError,
          );
        }
      }),
      { seed: SEMILLA, numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------- CA-5 precedencia y destinos
describe("precedencia (CA-5)", () => {
  it("con IGV = 0 solo dispara R-ISC, nunca R-MIX", () => {
    for (const bi of ["0.01", "21.48", "770.00", "999999999999.99"]) {
      const hs = evaluar([fila({ biDg: bi })]).hallazgos;
      expect(de(hs, "R-ISC")).toHaveLength(1);
      expect(de(hs, "R-MIX")).toHaveLength(0);
    }
  });

  it("BI 0.00 con IGV 0.00 en un destino: no dispara nada", () => {
    expect(evaluar([fila({ icbper: "0.50" })]).hallazgos).toEqual([]);
  });

  it("una fila que cuadra a 18 % o a 10 % (±0.01) no dispara R-MIX", () => {
    const sinMix = (bi: string, igv: string) =>
      de(evaluar([fila({ biDg: bi, igvDg: igv })]).hallazgos, "R-MIX").length === 0;
    for (const igv of ["17.99", "18.00", "18.01"]) expect(sinMix("100.00", igv)).toBe(true);
    for (const igv of ["9.99", "10.00", "10.01"]) expect(sinMix("100.00", igv)).toBe(true);
    for (const igv of ["3.86", "3.87", "3.88"]) expect(sinMix("21.48", igv)).toBe(true);
  });

  it("a 0.02 del 18 % o del 10 % sí dispara R-MIX", () => {
    const conMix = (bi: string, igv: string) =>
      de(evaluar([fila({ biDg: bi, igvDg: igv })]).hallazgos, "R-MIX").length === 1;
    for (const igv of ["17.98", "18.02", "9.98", "10.02"]) expect(conMix("100.00", igv)).toBe(true);
    for (const igv of ["3.85", "3.89"]) expect(conMix("21.48", igv)).toBe(true);
  });

  it("cada destino se evalúa por separado y el hallazgo trae su destino y su columna de BI", () => {
    const f = fila({
      biDg: "100.00", igvDg: "18.00", // cuadra: nada
      biDgng: "21.48", igvDgng: "1.61", // mixta
      biDng: "50.00", // IGV 0: R-ISC
    });
    const hs = evaluar([f]).hallazgos;
    expect(hs.map((h) => [h.regla, h.destino])).toEqual([
      ["R-ISC", "DNG"],
      ["R-MIX", "DGNG"],
    ]);
    const mix = hs[1]!;
    expect(sug(mix, "separar").columnaBi).toBe("biDgng");
    expect(mix.lecturas.biDgng?.toString()).toBe("21.48");
    expect(mix.lecturas.igvDgng?.toString()).toBe("1.61");
    const isc = hs[0]!;
    expect(sug(isc, "mover").origen).toBe("biDng");
  });

  it("los tres destinos a la vez: orden por regla (R-ISC, R-MIX) y luego DG, DGNG, DNG", () => {
    const f = fila({
      biDg: "770.00", // IGV 0: R-ISC
      biDgng: "21.48", igvDgng: "1.61", // R-MIX
      biDng: "50.00", // IGV 0: R-ISC
    });
    const hs = evaluar([f]).hallazgos;
    expect(hs.map((h) => [h.regla, h.destino])).toEqual([
      ["R-ISC", "DG"],
      ["R-ISC", "DNG"],
      ["R-MIX", "DGNG"],
    ]);
  });

  it("dos destinos mixtos en la misma fila: dos R-MIX independientes, cada uno con su rango", () => {
    const f = fila({ biDg: "21.48", igvDg: "1.61", biDng: "21.48", igvDng: "1.60" });
    const hs = de(evaluar([f]).hallazgos, "R-MIX");
    expect(hs.map((h) => h.destino)).toEqual(["DG", "DNG"]);
    expect(sug(hs[0]!, "separar").max.toString()).toBe("8.97");
    expect(sug(hs[1]!, "separar").max.toString()).toBe("8.91");
    expect(sug(hs[1]!, "separar").columnaBi).toBe("biDng");
  });
});

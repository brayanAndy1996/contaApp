// Spec 026 · T18 (adversario, ronda 2) del cálculo puro: dinero y coeficiente (R-3, R-4, R-5, R-7, R-8; U-7; CA-2, CA-3, CA-5, CA-6).
// Caja negra con la API pública de `@contapp/domain` (resolverMes, calcularProrrata, estimarIgv, compararProrrata, Money) y caja blanca de
// meses.ts / coeficiente.ts / porcentaje.ts: `mes()` y `calcularProrrata` suman con Money.suma, que lanza MontoFueraDeRangoError en cuanto
// el acumulado pasa de NUMERIC(14,2), aunque cada monto por separado sea un NUMERIC(14,2) válido (lo que la BD y `shared` aceptan).
import { describe, expect, it } from "vitest";
import { Money, calcularProrrata, compararProrrata, estimarIgv, resolverMes, type MesProrrata, type Presentacion } from "../index";

const Z = "0.00";
const MAXIMO = "999999999999.99"; // el mayor NUMERIC(14,2), que la BD y `montoProrrataSchema` aceptan por mes y por columna
const VENTANA = ["202511", "202512", "202601", "202602", "202603", "202604", "202605", "202606", "202607", "202608", "202609", "202610"];

function presentacion(o: Partial<Presentacion> = {}): Presentacion {
  return {
    numeroOrden: "1",
    fechaPresentacion: "2026-01-10",
    tipo: "original",
    ventasGravadasBase: Z,
    ventasGravadasIgv: Z,
    exportaciones: Z,
    noGravadas: Z,
    igvAdquisicionesDg: Z,
    igvAdquisicionesDgng: Z,
    prorrataUsada: null,
    ...o,
  };
}

/** Doce meses manuales con [gravadas, exportaciones, noGravadas] por índice. */
function manuales(f: (i: number) => [string, string, string]): MesProrrata[] {
  return VENTANA.map((periodo, i) => {
    const [gravadas, exportaciones, noGravadas] = f(i);
    return resolverMes({ periodo, declaraciones: [], manual: { gravadas, exportaciones, noGravadas }, sire: null });
  });
}

const sol = (s: string) => Money.desde(s, "PEN");

describe("R-3 / CA-2 · montos de 12 dígitos en los 12 meses (la suma sale de NUMERIC(14,2))", () => {
  it("11 meses gravados y 1 no gravado, todos en 999.999.999.999,99: no es un error sino «no determinable: montos_fuera_de_rango»", () => {
    // Cada mes es un NUMERIC(14,2) válido (lo admiten la BD, el PDT y el manual) y su total cabe; solo el acumulado de la ventana
    // (11.999.999.999.999,88) no cabe en NUMERIC(14,2). T20: la decisión del usuario del 2026-11-22 (H-026-2-4) sustituye la
    // expectativa original de T18 (91,67 %): sin excepción, coeficiente `{estado: "no_determinable", motivo: "montos_fuera_de_rango"}`.
    const meses = manuales((i) => (i === 0 ? [Z, Z, MAXIMO] : [MAXIMO, Z, Z]));
    let r: ReturnType<typeof calcularProrrata> | undefined;
    let error: unknown;
    try {
      r = calcularProrrata(meses);
    } catch (e) {
      error = e;
    }
    expect(error, `lanzó ${(error as Error | undefined)?.name}: la ventana no se puede calcular`).toBeUndefined();
    expect(r?.estado).toBe("no_determinable");
    expect(r?.estado === "no_determinable" ? r.motivo : null).toBe("montos_fuera_de_rango");
  });
});

describe("U-7 · …,5 exacto tras sumar 12 meses con notas de crédito (montos negativos)", () => {
  it("87,345 → 87,35; 0,005 → 0,01; 0,015 → 0,02 aunque el acumulado pase por negativos y -0.00", () => {
    // Σ gravadas = 10 × 10.000 − 12.655 = 87.345; Σ no gravadas = 20.000 − 7.345 + 0 = 12.655 → 87.345 / 100.000 = 87,345 %.
    const a = manuales((i) => [i < 10 ? "10000.00" : i === 10 ? "-12655.00" : "-0.00", Z, i === 0 ? "20000.00" : i === 5 ? "-7345.00" : "-0"]);
    expect(String((calcularProrrata(a) as { porcentaje: unknown }).porcentaje)).toBe("87.35");
    // 1 / 20.000 = 0,005 % y 3 / 20.000 = 0,015 %, con una nota de crédito que deja el numerador en su valor.
    const b = manuales((i) => [i === 0 ? "1.50" : i === 1 ? "-0.50" : Z, Z, i === 2 ? "19999.00" : Z]);
    expect(String((calcularProrrata(b) as { porcentaje: unknown }).porcentaje)).toBe("0.01");
    const c = manuales((i) => [i === 0 ? "3.01" : i === 1 ? "-0.01" : Z, Z, i === 2 ? "19997.00" : Z]);
    expect(String((calcularProrrata(c) as { porcentaje: unknown }).porcentaje)).toBe("0.02");
  });
});

describe("R-7 · IGV con DGNG negativo (notas de crédito de compras)", () => {
  it("creditoDgng es simétrico: −0,10 × 5,00 % = −0,005 → −0,01 (mitad alejándose de cero) y el resultado suma ese crédito negativo", () => {
    // 5 / 100 = 5,00 %.
    const meses = manuales((i) => [i === 0 ? "5.00" : Z, Z, i === 0 ? "95.00" : Z]);
    const r = calcularProrrata(meses);
    if (r.estado !== "calculado") throw new Error("se esperaba un coeficiente calculado");
    const pos = estimarIgv({ igvVentas: sol("100.00"), igvDg: sol("10.00"), igvDgng: sol("0.10"), igvDng: sol(Z), prorrata: r.porcentaje });
    const neg = estimarIgv({ igvVentas: sol("100.00"), igvDg: sol("10.00"), igvDgng: sol("-0.10"), igvDng: sol(Z), prorrata: r.porcentaje });
    expect(String(pos.creditoDgng)).toBe("0.01");
    expect(String(neg.creditoDgng)).toBe("-0.01");
    expect(String(neg.resultado)).toBe("90.01");
    expect(neg.situacion).toBe("a_pagar");
    // Todo DGNG negativo con DG que deja el resultado en −0,00: «cero», sin signo.
    const cero = estimarIgv({ igvVentas: sol("-0.01"), igvDg: sol(Z), igvDgng: sol("-0.10"), igvDng: sol(Z), prorrata: r.porcentaje });
    expect(String(cero.resultado)).toBe("0.00");
    expect(cero.situacion).toBe("cero");
  });
});

describe("R-5 / R-4 / R-8 · precedencia por número de orden, acumulados inválidos y prorrata usada", () => {
  it("rectificatoria con número de orden menor y fecha posterior no es la vigente; numerador > total y -0.00 no se calculan; «100», «0», «87.3»", () => {
    const original = presentacion({ numeroOrden: "10", fechaPresentacion: "2026-02-10", ventasGravadasBase: "100.00" });
    const rect = presentacion({ numeroOrden: "9", fechaPresentacion: "2026-09-30", tipo: "rectificatoria", ventasGravadasBase: "999.00" });
    for (const declaraciones of [[original, rect], [rect, original]]) {
      const m = resolverMes({ periodo: "202601", declaraciones, manual: null, sire: null });
      expect(String(m.gravadas)).toBe("100.00");
    }
    // Ceros negativos en todo: total 0 → no determinable `total_cero` (no un porcentaje ni NaN).
    expect(calcularProrrata(manuales(() => ["-0.00", "-0", "-0.0"]))).toEqual({ estado: "no_determinable", motivo: "total_cero" });
    // No gravadas acumuladas negativas: numerador 100 > total 50 → acumulado_invalido.
    expect(calcularProrrata(manuales((i) => [i === 0 ? "100.00" : Z, Z, i === 1 ? "-50.00" : Z]))).toEqual({
      estado: "no_determinable",
      motivo: "acumulado_invalido",
    });
    // Prorrata usada en los bordes contra una calculada de 100,00 y de 87,30.
    const cien = calcularProrrata(manuales(() => ["1.00", Z, Z]));
    const ochenta = calcularProrrata(manuales((i) => [i === 0 ? "87.30" : Z, Z, i === 0 ? "12.70" : Z]));
    if (cien.estado !== "calculado" || ochenta.estado !== "calculado") throw new Error("se esperaba calculado");
    expect(compararProrrata(cien.porcentaje, "100")).toEqual({ diferencia: "0.00", alerta: false });
    expect(compararProrrata(cien.porcentaje, "0")).toEqual({ diferencia: "100.00", alerta: true });
    expect(compararProrrata(ochenta.porcentaje, "87.3")).toEqual({ diferencia: "0.00", alerta: false });
    expect(compararProrrata(ochenta.porcentaje, "87.31")).toEqual({ diferencia: "-0.01", alerta: true });
    for (const malo of ["100.01", "-0", "1e2", " 87", "87,3", "８７", "87.300"]) {
      expect(() => compararProrrata(ochenta.porcentaje, malo), malo).toThrow();
    }
  });
});

// Spec 026 · T19 (tester; correcciones de la ronda adversarial 2, en rojo). H-026-2-4, decisión del usuario del 2026-11-22: cuando los 12
// meses suman más de lo que cabe en NUMERIC(14,2) (999.999.999.999,99) en el numerador o en el total, `calcularProrrata` NO lanza
// `MontoFueraDeRangoError`: devuelve `{estado: "no_determinable", motivo: "montos_fuera_de_rango"}` (motivo propio de la prorrata) y la
// lectura responde 200 con la tabla. Cada mes por separado sigue siendo un NUMERIC(14,2) válido (lo admiten la BD, el PDT y el manual).
// Esto REEMPLAZA la expectativa de 91,67 % de `prorrata-r2.adv.spec.ts` («11 meses gravados y 1 no gravado…»), que el usuario descartó:
// T20 ajusta esa prueba adversarial a este contrato (anotándolo en su resultado).
import { describe, expect, it } from "vitest";
import { MontoFueraDeRangoError, calcularProrrata, resolverMes, type MesProrrata } from "../index";

const Z = "0.00";
const MAXIMO = "999999999999.99";
const VENTANA = ["202511", "202512", "202601", "202602", "202603", "202604", "202605", "202606", "202607", "202608", "202609", "202610"];

/** Doce meses manuales con [gravadas, exportaciones, noGravadas] por índice. */
function manuales(f: (i: number) => [string, string, string]): MesProrrata[] {
  return VENTANA.map((periodo, i) => {
    const [gravadas, exportaciones, noGravadas] = f(i);
    return resolverMes({ periodo, declaraciones: [], manual: { gravadas, exportaciones, noGravadas }, sire: null });
  });
}

const FUERA = { estado: "no_determinable", motivo: "montos_fuera_de_rango" } as const;

describe("H-026-2-4 · el acumulado de la ventana no cabe en NUMERIC(14,2): no determinable, no excepción", () => {
  it("11 meses gravados y 1 no gravado, todos en 999.999.999.999,99: no lanza y da `montos_fuera_de_rango`", () => {
    const meses = manuales((i) => (i === 0 ? [Z, Z, MAXIMO] : [MAXIMO, Z, Z]));
    expect(() => calcularProrrata(meses)).not.toThrow();
    expect(calcularProrrata(meses)).toEqual(FUERA);
  });

  it("solo ventas gravadas de 12 dígitos en los 12 meses (el numerador no cabe): `montos_fuera_de_rango`", () => {
    expect(calcularProrrata(manuales(() => [MAXIMO, Z, Z]))).toEqual(FUERA);
  });

  it("solo exportaciones de 12 dígitos en los 12 meses: `montos_fuera_de_rango`", () => {
    expect(calcularProrrata(manuales(() => [Z, MAXIMO, Z]))).toEqual(FUERA);
  });

  it("solo no gravadas de 12 dígitos en los 12 meses (el numerador es 0 y el total no cabe): `montos_fuera_de_rango`", () => {
    expect(calcularProrrata(manuales(() => [Z, Z, MAXIMO]))).toEqual(FUERA);
  });

  it("el numerador cabe pero el total no: `montos_fuera_de_rango`", () => {
    // Σ gravadas = 11 × 80.000.000.000,00 = 880.000.000.000,00 (cabe); Σ no gravadas = 12 × 80.000.000.000,00 → total 1,84 billones.
    const meses = manuales((i) => [i < 11 ? "80000000000.00" : Z, Z, "80000000000.00"]);
    expect(calcularProrrata(meses)).toEqual(FUERA);
  });

  it("el resultado es un objeto de dominio, no un `MontoFueraDeRangoError` escondido", () => {
    let r: unknown;
    try {
      r = calcularProrrata(manuales(() => [MAXIMO, Z, Z]));
    } catch (e) {
      expect(e instanceof MontoFueraDeRangoError, "lanzó MontoFueraDeRangoError").toBe(false);
      throw e;
    }
    expect(Object.keys(r as object).sort()).toEqual(["estado", "motivo"]);
  });

  it("control: 12 meses de 80.000.000.000,00 (el acumulado de 960.000.000.000,00 cabe): se calcula con normalidad", () => {
    const r = calcularProrrata(manuales((i) => (i === 0 ? [Z, Z, "80000000000.00"] : ["80000000000.00", Z, Z])));
    expect(r.estado).toBe("calculado");
    expect(r.estado === "calculado" ? String(r.porcentaje) : null).toBe("91.67");
  });

  it("control: faltar un mes sigue teniendo precedencia (R-6) aunque los demás sean de 12 dígitos", () => {
    const meses = VENTANA.map((periodo, i) =>
      i === 3
        ? resolverMes({ periodo, declaraciones: [], manual: null, sire: null })
        : resolverMes({ periodo, declaraciones: [], manual: { gravadas: MAXIMO, exportaciones: Z, noGravadas: Z }, sire: null }),
    );
    expect(calcularProrrata(meses)).toEqual({ estado: "faltan_meses", faltantes: ["202602"] });
  });

  it("control: el total en cero y el acumulado inválido siguen con sus motivos de siempre", () => {
    expect(calcularProrrata(manuales(() => [Z, Z, Z]))).toEqual({ estado: "no_determinable", motivo: "total_cero" });
    expect(calcularProrrata(manuales((i) => [i === 0 ? "100.00" : Z, Z, i === 1 ? "-50.00" : Z]))).toEqual({
      estado: "no_determinable",
      motivo: "acumulado_invalido",
    });
  });
});

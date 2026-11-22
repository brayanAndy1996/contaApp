// Spec 026 · T1 (rojo). calcularProrrata(meses[12]) → coeficiente (R-3, R-4, R-6, R-2b, U-6, U-7; CA-2).
// Contrato (plan 026): {estado: "calculado", porcentaje, numerador, total, provisional, avisos}
//   | {estado: "faltan_meses", faltantes: string[]} | {estado: "no_determinable", motivo: "total_cero" | "acumulado_invalido"}.
// Avisos del coeficiente: `numerador_cero` y `exportaciones_en_sire`. `provisional` si algún mes es SIRE o manual.
// Los meses se arman con `resolverMes` (ayudas) para no depender de la representación interna de MesProrrata.
import { describe, expect, it } from "vitest";
import {
  VENTANA_202610 as V,
  conMes,
  docePorMes,
  mesDeclarado,
  mesFalta,
  mesManual,
  mesSire,
} from "../../tests/ayudas/prorrata";
import { calcularProrrata } from "./coeficiente";

const Z = "0.00";
/** Doce meses manuales: monto de cada mes por índice. */
const manuales = (f: (i: number) => [string, string, string]) => docePorMes((_p, i) => f(i), "manual");
const declarados = (f: (i: number) => [string, string, string]) => docePorMes((_p, i) => f(i), "declarado");
const resumen = (r: ReturnType<typeof calcularProrrata>) =>
  r.estado === "calculado"
    ? { estado: r.estado, porcentaje: String(r.porcentaje), numerador: String(r.numerador), total: String(r.total) }
    : r;

describe("calcularProrrata: tabla de casos de CA-2", () => {
  it("todo gravado → 100.00 (numerador = total), sin provisional si los 12 meses son declarados", () => {
    const r = calcularProrrata(declarados(() => ["1000.00", Z, Z]));
    expect(resumen(r)).toEqual({ estado: "calculado", porcentaje: "100.00", numerador: "12000.00", total: "12000.00" });
    expect(r).toMatchObject({ provisional: false, avisos: [] });
  });

  it("todo no gravado → 0.00 válido con el aviso `numerador_cero` (R-4)", () => {
    const r = calcularProrrata(manuales(() => [Z, Z, "500.00"]));
    expect(resumen(r)).toEqual({ estado: "calculado", porcentaje: "0.00", numerador: "0.00", total: "6000.00" });
    expect(r).toMatchObject({ provisional: true, avisos: ["numerador_cero"] });
  });

  it("solo exportaciones → 100.00 (las exportaciones suman al numerador)", () => {
    const r = calcularProrrata(declarados(() => [Z, "1000.00", Z]));
    expect(resumen(r)).toEqual({ estado: "calculado", porcentaje: "100.00", numerador: "12000.00", total: "12000.00" });
    expect(r).toMatchObject({ avisos: [] });
  });

  it("gravadas + exportaciones frente a no gravadas: numerador = Σ(gravadas + exportaciones), total = numerador + Σ no gravadas", () => {
    const r = calcularProrrata(declarados((i) => [`${(i + 1) * 100}.00`, i === 4 ? "300.00" : Z, `${(12 - i) * 50}.00`]));
    // Σ gravadas 7800 + exportaciones 300 = 8100 · no gravadas 3900 · total 12000 → 67.50
    expect(resumen(r)).toEqual({ estado: "calculado", porcentaje: "67.50", numerador: "8100.00", total: "12000.00" });
  });

  it.each([
    ["…,345 exacto sube (mitad hacia arriba)", "87345.00", "12655.00", "87.35"],
    ["…,344 baja", "87344.00", "12656.00", "87.34"],
    ["tercer decimal 4 con resto baja", "87344.01", "12655.99", "87.34"],
    ["tercer decimal 5 con resto sube", "87345.01", "12654.99", "87.35"],
    ["1/3 → 33.33", "1000.00", "2000.00", "33.33"],
    ["2/3 → 66.67", "2000.00", "1000.00", "66.67"],
  ])("mixto con redondeo: %s", (_n, g, n, esperado) => {
    const meses = conMes(conMes(declarados(() => [Z, Z, Z]), 0, mesDeclarado(V[0], g, Z, Z)), 1, mesDeclarado(V[1], Z, Z, n));
    expect(resumen(calcularProrrata(meses))).toMatchObject({ estado: "calculado", porcentaje: esperado });
  });

  it("notas de crédito: un mes con más notas que ventas se muestra negativo y el acumulado sigue calculable", () => {
    const meses = declarados((i) => [i === 2 ? "-500.00" : "1000.00", Z, i === 0 ? "3000.00" : Z]);
    expect(String(meses[2].total)).toBe("-500.00");
    expect(String(meses[2].gravadas)).toBe("-500.00");
    // numerador 11 × 1000 − 500 = 10500 · total 13500 → 77.78
    expect(resumen(calcularProrrata(meses))).toEqual({
      estado: "calculado",
      porcentaje: "77.78",
      numerador: "10500.00",
      total: "13500.00",
    });
  });

  it("no gravadas acumuladas en cero con numerador > 0 → 100.00 (numerador = total es válido)", () => {
    const r = calcularProrrata(manuales((i) => ["1000.00", Z, i === 0 ? "100.00" : i === 1 ? "-100.00" : Z]));
    expect(resumen(r)).toMatchObject({ estado: "calculado", porcentaje: "100.00", numerador: "12000.00", total: "12000.00" });
  });

  it("montos de 12 dígitos: 12 × 83333333333.33 = 999999999999.96 → 100.00", () => {
    const r = calcularProrrata(manuales(() => ["83333333333.33", Z, Z]));
    expect(resumen(r)).toEqual({ estado: "calculado", porcentaje: "100.00", numerador: "999999999999.96", total: "999999999999.96" });
  });

  it("montos de 12 dígitos con el total en el límite de NUMERIC(14,2): 999999999999.96 / 999999999999.99 → 100.00", () => {
    const meses = manuales((i) => ["83333333333.33", Z, i === 0 ? "0.03" : Z]);
    expect(resumen(calcularProrrata(meses))).toEqual({
      estado: "calculado",
      porcentaje: "100.00",
      numerador: "999999999999.96",
      total: "999999999999.99",
    });
  });

  it("un numerador de 0.01 sobre un total de 12 dígitos redondea a 0.00 sin lanzar", () => {
    const meses = manuales((i) => [i === 0 ? "0.01" : Z, Z, "83333333333.33"]);
    expect(resumen(calcularProrrata(meses))).toMatchObject({ estado: "calculado", porcentaje: "0.00" });
  });
});

describe("calcularProrrata: no determinable (R-4, U-6)", () => {
  it("total 0 (todos los meses en 0, «sin operaciones») → no_determinable `total_cero`, sin porcentaje", () => {
    const r = calcularProrrata(manuales(() => [Z, Z, Z]));
    expect(r).toEqual({ estado: "no_determinable", motivo: "total_cero" });
  });

  it.each([
    ["acumulado negativo (más notas que ventas)", () => manuales(() => ["-100.00", Z, Z])],
    ["numerador negativo con total positivo", () => manuales(() => ["-100.00", Z, "500.00"])],
    ["no gravadas acumuladas negativas → numerador > total", () => manuales(() => ["1000.00", Z, "-100.00"])],
    ["total negativo con numerador 0", () => manuales(() => [Z, Z, "-100.00"])],
  ])("%s → no_determinable `acumulado_invalido`", (_n, f) => {
    expect(calcularProrrata(f())).toEqual({ estado: "no_determinable", motivo: "acumulado_invalido" });
  });
});

describe("calcularProrrata: meses faltantes (R-6, U-5)", () => {
  it("lista los meses sin origen en el orden de la ventana y no calcula", () => {
    const meses = conMes(conMes(manuales(() => [Z, Z, Z]), 2, mesFalta(V[2])), 7, mesFalta(V[7]));
    const r = calcularProrrata(meses);
    expect(r).toEqual({ estado: "faltan_meses", faltantes: [V[2], V[7]] });
    expect(r).not.toHaveProperty("porcentaje");
  });

  it("todos faltan → los 12 en orden", () => {
    const r = calcularProrrata(V.map((p) => mesFalta(p)));
    expect(r).toEqual({ estado: "faltan_meses", faltantes: V });
  });

  it("faltar un mes tiene precedencia sobre un acumulado inválido o un total 0", () => {
    const r = calcularProrrata(conMes(manuales(() => ["-100.00", Z, Z]), 11, mesFalta(V[11])));
    expect(r).toEqual({ estado: "faltan_meses", faltantes: [V[11]] });
  });

  it("un mes SIRE o manual en 0 no es faltante", () => {
    const meses = conMes(manuales(() => ["10.00", Z, Z]), 3, mesSire(V[3], Z));
    expect(calcularProrrata(meses).estado).toBe("calculado");
  });
});

describe("calcularProrrata: provisional y avisos de exportaciones (R-5, R-2b)", () => {
  it("provisional = false solo si los 12 meses son declarados; basta un SIRE o un manual para que sea true", () => {
    const base = declarados(() => ["100.00", Z, "50.00"]);
    expect(calcularProrrata(base)).toMatchObject({ provisional: false });
    expect(calcularProrrata(conMes(base, 6, mesSire(V[6], "100.00", "50.00")))).toMatchObject({ provisional: true });
    expect(calcularProrrata(conMes(base, 6, mesManual(V[6], "100.00", Z, "50.00")))).toMatchObject({ provisional: true });
  });

  it("un mes declarado con exportaciones y otro SIRE → aviso `exportaciones_en_sire`", () => {
    const meses = conMes(conMes(declarados(() => ["1000.00", Z, Z]), 0, mesDeclarado(V[0], "1000.00", "500.00", Z)), 5, mesSire(V[5], "1000.00"));
    expect(calcularProrrata(meses)).toMatchObject({ estado: "calculado", avisos: ["exportaciones_en_sire"] });
  });

  it("un mes manual con exportaciones y otro SIRE → el mismo aviso", () => {
    const meses = conMes(conMes(declarados(() => ["1000.00", Z, Z]), 0, mesManual(V[0], "1000.00", "500.00", Z)), 5, mesSire(V[5], "1000.00"));
    expect(calcularProrrata(meses)).toMatchObject({ avisos: ["exportaciones_en_sire"] });
  });

  it("sin ningún mes SIRE no hay aviso aunque haya exportaciones declaradas", () => {
    const meses = conMes(declarados(() => ["1000.00", Z, Z]), 0, mesDeclarado(V[0], "1000.00", "500.00", Z));
    expect(calcularProrrata(meses)).toMatchObject({ avisos: [] });
  });

  it("con meses SIRE pero ninguna exportación declarada o manual no hay aviso (el SIRE siempre trae exportaciones 0)", () => {
    const meses = conMes(declarados(() => ["1000.00", Z, Z]), 5, mesSire(V[5], "1000.00"));
    expect(calcularProrrata(meses)).toMatchObject({ avisos: [] });
  });
});

describe("calcularProrrata: robustez", () => {
  it("no muta los meses de entrada y da el mismo resultado en dos llamadas", () => {
    const meses = manuales((i) => [`${i + 1}00.00`, Z, "10.00"]);
    const copia = [...meses];
    const a = calcularProrrata(meses);
    const b = calcularProrrata(meses);
    expect(meses).toEqual(copia);
    expect(resumen(a)).toEqual(resumen(b));
  });
});

describe("ninguna salida del coeficiente es `number` (CA-2)", () => {
  it("numerador, total y porcentaje de un resultado calculado, y el total de cada mes, no son `number`", () => {
    const meses = declarados((i) => [`${(i + 1) * 100}.00`, Z, "10.00"]);
    for (const m of meses) {
      for (const v of [m.gravadas, m.exportaciones, m.noGravadas, m.total]) expect(typeof v).not.toBe("number");
    }
    const r = calcularProrrata(meses);
    expect(r.estado).toBe("calculado");
    if (r.estado === "calculado") {
      for (const v of [r.numerador, r.total, r.porcentaje]) expect(typeof v).not.toBe("number");
    }
  });
});

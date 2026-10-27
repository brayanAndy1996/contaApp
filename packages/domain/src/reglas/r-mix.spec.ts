// T4 (rojo): R-MIX (RF-082; CA-2, CA-3, CA-10; D-3, D-7) vía evaluarReglas/aplicarSugerencia.
import { describe, expect, it } from "vitest";
import { MonedaDistintaError } from "../dinero/index";
import { ctxBase, de, evaluar, fila, pen, sug, unico, usd, xmlDe } from "../../tests/ayudas/filas";
import { ConfirmacionInvalidaError, aplicarSugerencia } from "./index";
import type { FilaEvaluable } from "./index";

/** Entorno con el que se evaluó el hallazgo (T15b-1). */
const ent = (filas: FilaEvaluable[], contexto = ctxBase()) => ({ filas, contexto });

const MIXTA = { biDg: "21.48", igvDg: "1.61" }; // total 23.09
const EXPLICACION_MIXTA = "1.61 no es 18 % ni 10 % de 21.48";

describe("R-MIX sin XML: la mixta 21.48 / 1.61 (CA-2, HU-24)", () => {
  it("un hallazgo R-MIX con rango gravado 8.92–8.97, estimado 8.94 y sin exacto", () => {
    const { hallazgos, avisos } = evaluar([fila(MIXTA)]);
    expect(avisos).toEqual([]);
    expect(hallazgos).toHaveLength(1);
    const h = unico(hallazgos, "R-MIX");
    expect(h.filaId).toBe("f1");
    expect(h.destino).toBe("DG");
    const s = sug(h, "separar");
    expect(s.columnaBi).toBe("biDg");
    expect(s.min.toString()).toBe("8.92");
    expect(s.max.toString()).toBe("8.97");
    expect(s.estimado.toString()).toBe("8.94");
    expect(s.exacto).toBeNull();
    expect(s.min.moneda).toBe("PEN");
    expect(h.requiereConfirmacion).toBe(true);
    expect(h.dato).toBe("gravado");
  });

  it("explica '1.61 no es 18 % ni 10 % de 21.48'", () => {
    const h = unico(evaluar([fila(MIXTA)]).hallazgos, "R-MIX");
    expect(h.explicacion).toContain(EXPLICACION_MIXTA);
  });

  it("lecturas: BI e IGV del destino", () => {
    const h = unico(evaluar([fila(MIXTA)]).hallazgos, "R-MIX");
    expect(h.lecturas.biDg?.toString()).toBe("21.48");
    expect(h.lecturas.igvDg?.toString()).toBe("1.61");
  });

  it("aplicar con 8.97: gravado 8.97, no gravado 12.51, IGV intacto y total igual", () => {
    const f = fila(MIXTA);
    const h = unico(evaluar([f]).hallazgos, "R-MIX");
    const r = aplicarSugerencia(f.montos, h, { gravado: pen("8.97") }, ent([f]));
    expect(r.excluir).toBe(false);
    expect(r.montos.obtener("biDg").toString()).toBe("8.97");
    expect(r.montos.obtener("noGravado").toString()).toBe("12.51");
    expect(r.montos.obtener("igvDg").toString()).toBe("1.61");
    expect(r.montos.total.toString()).toBe("23.09");
    expect(f.montos.obtener("biDg").toString()).toBe("21.48");
  });

  it("aplicar acepta los bordes 8.92 y 8.97 y el estimado 8.94", () => {
    const f = fila(MIXTA);
    const h = unico(evaluar([f]).hallazgos, "R-MIX");
    const con = (g: string) => aplicarSugerencia(f.montos, h, { gravado: pen(g) }, ent([f])).montos;
    expect(con("8.92").obtener("noGravado").toString()).toBe("12.56");
    expect(con("8.94").obtener("noGravado").toString()).toBe("12.54");
    expect(con("8.97").obtener("noGravado").toString()).toBe("12.51");
  });

  it("aplicar sin monto confirmado lanza ConfirmacionInvalidaError", () => {
    const f = fila(MIXTA);
    const h = unico(evaluar([f]).hallazgos, "R-MIX");
    expect(() => aplicarSugerencia(f.montos, h, undefined, ent([f]))).toThrow(ConfirmacionInvalidaError);
  });

  it("aplicar con un gravado fuera del rango (8.91 y 8.98) lanza ConfirmacionInvalidaError", () => {
    const f = fila(MIXTA);
    const h = unico(evaluar([f]).hallazgos, "R-MIX");
    expect(() => aplicarSugerencia(f.montos, h, { gravado: pen("8.91") }, ent([f]))).toThrow(ConfirmacionInvalidaError);
    expect(() => aplicarSugerencia(f.montos, h, { gravado: pen("8.98") }, ent([f]))).toThrow(ConfirmacionInvalidaError);
    expect(() => aplicarSugerencia(f.montos, h, { gravado: pen("0.00") }, ent([f]))).toThrow(ConfirmacionInvalidaError);
  });

  it("aplicar con una confirmación de otro tipo ({ destino }) lanza ConfirmacionInvalidaError", () => {
    const f = fila(MIXTA);
    const h = unico(evaluar([f]).hallazgos, "R-MIX");
    expect(() => aplicarSugerencia(f.montos, h, { destino: "DG" }, ent([f]))).toThrow(ConfirmacionInvalidaError);
  });

  it("aplicar con un gravado en otra moneda propaga MonedaDistintaError de 010", () => {
    const f = fila(MIXTA);
    const h = unico(evaluar([f]).hallazgos, "R-MIX");
    expect(() => aplicarSugerencia(f.montos, h, { gravado: usd("8.97") }, ent([f]))).toThrow(MonedaDistintaError);
  });

  it("no se dispara R-ISC ni otra regla en la mixta (IGV ≠ 0)", () => {
    const { hallazgos } = evaluar([fila(MIXTA)]);
    expect(hallazgos.map((h) => h.regla)).toEqual(["R-MIX"]);
  });
});

describe("R-MIX con XML (CA-3, D-3, D-7)", () => {
  const xmlOk = { gravado: "8.97", igv: "1.61", noGravado: "12.51" };

  it("con XML de gravado 8.97: sugerencia exacta 8.97 (no gravado 12.51), sin confirmación", () => {
    const f = fila(MIXTA, { xml: xmlDe(xmlOk) });
    const h = unico(evaluar([f]).hallazgos, "R-MIX");
    const s = sug(h, "separar");
    expect(s.exacto?.toString()).toBe("8.97");
    expect(s.min.toString()).toBe("8.92");
    expect(s.max.toString()).toBe("8.97");
    expect(h.requiereConfirmacion).toBe(false);
    expect(h.dato).toBeNull();
    const r = aplicarSugerencia(f.montos, h, undefined, ent([f]));
    expect(r.montos.obtener("biDg").toString()).toBe("8.97");
    expect(r.montos.obtener("noGravado").toString()).toBe("12.51");
    expect(r.montos.total.toString()).toBe("23.09");
  });

  it("el gravado del XML en el borde del rango (8.92) es exacto", () => {
    const f = fila(MIXTA, { xml: xmlDe({ gravado: "8.92", igv: "1.61", noGravado: "12.56" }) });
    const s = sug(unico(evaluar([f]).hallazgos, "R-MIX"), "separar");
    expect(s.exacto?.toString()).toBe("8.92");
  });

  it("exacto a 10 % (solo con XML, D-7): BI 80.00 / IGV 5.00 con gravado del XML 50.00", () => {
    const f = fila({ biDg: "80.00", igvDg: "5.00" }, {
      xml: xmlDe({ gravado: "50.00", igv: "5.00", noGravado: "30.00" }),
    });
    const h = unico(evaluar([f]).hallazgos, "R-MIX");
    const s = sug(h, "separar");
    // El estimado y el rango sin XML son siempre a 18 % (D-7).
    expect(s.min.toString()).toBe("27.75");
    expect(s.max.toString()).toBe("27.80");
    expect(s.estimado.toString()).toBe("27.78");
    expect(s.exacto?.toString()).toBe("50.00");
    expect(h.requiereConfirmacion).toBe(false);
    const r = aplicarSugerencia(f.montos, h, undefined, ent([f]));
    expect(r.montos.obtener("biDg").toString()).toBe("50.00");
    expect(r.montos.obtener("noGravado").toString()).toBe("30.00");
    expect(r.montos.total.toString()).toBe("85.00");
  });

  it("sin XML, BI 80.00 / IGV 5.00 usa solo 18 %: rango 27.75–27.80 y sin exacto (D-7)", () => {
    const s = sug(unico(evaluar([fila({ biDg: "80.00", igvDg: "5.00" })]).hallazgos, "R-MIX"), "separar");
    expect([s.min.toString(), s.max.toString(), s.estimado.toString()]).toEqual(["27.75", "27.80", "27.78"]);
    expect(s.exacto).toBeNull();
  });

  it("gravado del XML fuera del rango (8.91 y 8.98) y fuera del 10 %: sin exacto, requiere confirmación y se explica", () => {
    const sinXml = unico(evaluar([fila(MIXTA)]).hallazgos, "R-MIX");
    for (const g of ["8.91", "8.98", "9.50"]) {
      const f = fila(MIXTA, { xml: xmlDe({ gravado: g, igv: "1.61", noGravado: "11.98" }) });
      const h = unico(evaluar([f]).hallazgos, "R-MIX");
      const s = sug(h, "separar");
      expect(s.exacto).toBeNull();
      expect(h.requiereConfirmacion).toBe(true);
      expect(h.dato).toBe("gravado");
      expect(h.explicacion).not.toBe(sinXml.explicacion);
    }
  });

  it("IGV del XML distinto del SIRE: sin exacto y se explica", () => {
    const f = fila(MIXTA, { xml: xmlDe({ gravado: "8.97", igv: "1.62", noGravado: "12.51" }) });
    const h = unico(evaluar([f]).hallazgos, "R-MIX");
    expect(sug(h, "separar").exacto).toBeNull();
    expect(h.requiereConfirmacion).toBe(true);
    expect(h.explicacion).not.toBe(unico(evaluar([fila(MIXTA)]).hallazgos, "R-MIX").explicacion);
  });

  it("con varios destinos con BI no cero, el gravado del XML no se asigna a ninguno: sin exacto", () => {
    const f = fila(
      { biDg: "21.48", igvDg: "1.61", biDgng: "50.00", igvDgng: "9.00" },
      { xml: xmlDe({ gravado: "8.97", igv: "10.61", noGravado: "62.51" }) },
    );
    const hs = de(evaluar([f]).hallazgos, "R-MIX");
    expect(hs).toHaveLength(1);
    expect(hs[0]!.destino).toBe("DG");
    expect(sug(hs[0]!, "separar").exacto).toBeNull();
  });
});

describe("R-MIX sin sugerencia: rango vacío (CA-4)", () => {
  it("BI 0.00 con IGV 5.00: hallazgo sin sugerencia", () => {
    const h = unico(evaluar([fila({ igvDg: "5.00" })]).hallazgos, "R-MIX");
    expect(h.sugerencia).toBeNull();
    expect(h.dato).toBeNull();
    expect(h.explicacion.length).toBeGreaterThan(0);
    expect(h.destino).toBe("DG");
  });

  it("IGV mayor que el 18 % de la BI (3.00 sobre 10.00): sin sugerencia", () => {
    const h = unico(evaluar([fila({ biDg: "10.00", igvDg: "3.00" })]).hallazgos, "R-MIX");
    expect(h.sugerencia).toBeNull();
  });

  it("IGV mayor que la BI (20.00 sobre 10.00): sin sugerencia", () => {
    const h = unico(evaluar([fila({ biDg: "10.00", igvDg: "20.00" })]).hallazgos, "R-MIX");
    expect(h.sugerencia).toBeNull();
  });

  it("BI e IGV de signo distinto: R-MIX sin sugerencia", () => {
    const h = unico(evaluar([fila({ biDg: "21.48", igvDg: "-1.61" })]).hallazgos, "R-MIX");
    expect(h.sugerencia).toBeNull();
  });

  it("con XML, un rango vacío tampoco produce sugerencia exacta", () => {
    const f = fila({ biDg: "10.00", igvDg: "3.00" }, { xml: xmlDe({ gravado: "10.00", igv: "3.00" }) });
    expect(unico(evaluar([f]).hallazgos, "R-MIX").sugerencia).toBeNull();
  });
});

describe("R-MIX: signos y moneda (CA-10)", () => {
  it("nota de crédito -21.48 / -1.61: mismo signo; el estimado es -8.94 y los límites son -8.92 y -8.97", () => {
    const f = fila({ biDg: "-21.48", igvDg: "-1.61" });
    const h = unico(evaluar([f]).hallazgos, "R-MIX");
    const s = sug(h, "separar");
    expect(s.estimado.toString()).toBe("-8.94");
    // Ratificación (plan): min ≤ max numéricamente, también en notas de crédito.
    expect(s.min.toString()).toBe("-8.97");
    expect(s.max.toString()).toBe("-8.92");
    expect(h.explicacion).toContain("1.61");
    const r = aplicarSugerencia(f.montos, h, { gravado: pen("-8.97") }, ent([f]));
    expect(r.montos.obtener("biDg").toString()).toBe("-8.97");
    expect(r.montos.obtener("noGravado").toString()).toBe("-12.51");
    expect(r.montos.obtener("igvDg").toString()).toBe("-1.61");
    expect(r.montos.total.toString()).toBe("-23.09");
  });

  it("nota de crédito: aplicar acepta -8.92 y -8.97 (bordes) y rechaza -8.91 y -8.98", () => {
    const f = fila({ biDg: "-21.48", igvDg: "-1.61" });
    const h = unico(evaluar([f]).hallazgos, "R-MIX");
    const con = (g: string) => aplicarSugerencia(f.montos, h, { gravado: pen(g) }, ent([f])).montos;
    expect(con("-8.92").obtener("noGravado").toString()).toBe("-12.56");
    expect(con("-8.97").obtener("noGravado").toString()).toBe("-12.51");
    expect(() => con("-8.91")).toThrow(ConfirmacionInvalidaError);
    expect(() => con("-8.98")).toThrow(ConfirmacionInvalidaError);
  });

  it("nota de crédito: un gravado de signo opuesto es una confirmación inválida", () => {
    const f = fila({ biDg: "-21.48", igvDg: "-1.61" });
    const h = unico(evaluar([f]).hallazgos, "R-MIX");
    expect(() => aplicarSugerencia(f.montos, h, { gravado: pen("8.97") }, ent([f]))).toThrow(ConfirmacionInvalidaError);
  });

  it("nota de crédito con XML negativo: exacto -8.97", () => {
    const f = fila({ biDg: "-21.48", igvDg: "-1.61" }, {
      xml: xmlDe({ gravado: "-8.97", igv: "-1.61", noGravado: "-12.51" }),
    });
    const h = unico(evaluar([f]).hallazgos, "R-MIX");
    expect(sug(h, "separar").exacto?.toString()).toBe("-8.97");
    expect(h.requiereConfirmacion).toBe(false);
  });

  it("fila USD: se evalúa en USD (rango, estimado y aplicar en USD)", () => {
    const f = fila(MIXTA, { moneda: "USD" });
    const h = unico(evaluar([f]).hallazgos, "R-MIX");
    const s = sug(h, "separar");
    expect([s.min.moneda, s.max.moneda, s.estimado.moneda]).toEqual(["USD", "USD", "USD"]);
    expect([s.min.toString(), s.max.toString(), s.estimado.toString()]).toEqual(["8.92", "8.97", "8.94"]);
    const r = aplicarSugerencia(f.montos, h, { gravado: usd("8.97") }, ent([f]));
    expect(r.montos.moneda).toBe("USD");
    expect(r.montos.obtener("noGravado").toString()).toBe("12.51");
    expect(() => aplicarSugerencia(f.montos, h, { gravado: pen("8.97") }, ent([f]))).toThrow(MonedaDistintaError);
  });

  it("fila USD con XML en USD: exacto en USD", () => {
    const f = fila(MIXTA, { moneda: "USD", xml: xmlDe({ moneda: "USD", gravado: "8.97", igv: "1.61", noGravado: "12.51" }) });
    const s = sug(unico(evaluar([f]).hallazgos, "R-MIX"), "separar");
    expect(s.exacto?.moneda).toBe("USD");
    expect(s.exacto?.toString()).toBe("8.97");
  });
});

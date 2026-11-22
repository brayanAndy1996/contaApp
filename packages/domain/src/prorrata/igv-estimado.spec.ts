// Spec 026 · T1 (rojo). estimarIgv({igvVentas, igvDg, igvDgng, igvDng, prorrata}) (R-7, U-8; CA-5, HU-36).
// Contrato (plan 026): → {igvVentas, creditoDg, igvDgng, creditoDgng, igvDng, resultado, situacion}; los cinco montos de entrada son
// Money en soles (creditoDgng = redondearSunat(igvDgng.por(prorrata.comoFactor()))) y `prorrata` es el Porcentaje de porcentajeProrrata.
// resultado = igvVentas − creditoDg − creditoDgng; situacion: "a_pagar" (> 0) | "saldo_a_favor" (< 0) | "cero". DNG no da crédito.
import { describe, expect, it } from "vitest";
import { pen } from "../../tests/ayudas/prorrata";
import { estimarIgv } from "./igv-estimado";
import { porcentajeProrrata } from "./porcentaje";

const prorrata = (n: string, t: string) => porcentajeProrrata(pen(n), pen(t));
const P8734 = prorrata("87340.00", "100000.00"); // 87.34
const P50 = prorrata("1.00", "2.00"); // 50.00
const P0 = prorrata("0.00", "100.00");
const P100 = prorrata("100.00", "100.00");

const entrada = (o: Partial<Record<"igvVentas" | "igvDg" | "igvDgng" | "igvDng", string>> = {}, p = P50) => ({
  igvVentas: pen(o.igvVentas ?? "0.00"),
  igvDg: pen(o.igvDg ?? "0.00"),
  igvDgng: pen(o.igvDgng ?? "0.00"),
  igvDng: pen(o.igvDng ?? "0.00"),
  prorrata: p,
});
const texto = (r: ReturnType<typeof estimarIgv>) => ({
  igvVentas: String(r.igvVentas),
  creditoDg: String(r.creditoDg),
  igvDgng: String(r.igvDgng),
  creditoDgng: String(r.creditoDgng),
  igvDng: String(r.igvDng),
  resultado: String(r.resultado),
  situacion: r.situacion,
});

describe("estimarIgv: resultado y situación", () => {
  it("a pagar: 1800.00 − 300.00 − (200.00 × 87.34 %) = 1325.32", () => {
    const r = estimarIgv(entrada({ igvVentas: "1800.00", igvDg: "300.00", igvDgng: "200.00", igvDng: "40.00" }, P8734));
    expect(texto(r)).toEqual({
      igvVentas: "1800.00",
      creditoDg: "300.00",
      igvDgng: "200.00",
      creditoDgng: "174.68",
      igvDng: "40.00",
      resultado: "1325.32",
      situacion: "a_pagar",
    });
  });

  it("saldo a favor: 100.00 − 250.00 − 50.00 = −200.00", () => {
    const r = estimarIgv(entrada({ igvVentas: "100.00", igvDg: "250.00", igvDgng: "100.00" }));
    expect(texto(r)).toMatchObject({ creditoDgng: "50.00", resultado: "-200.00", situacion: "saldo_a_favor" });
  });

  it("cero: 150.00 − 100.00 − 50.00 = 0.00 (sin -0.00)", () => {
    const r = estimarIgv(entrada({ igvVentas: "150.00", igvDg: "100.00", igvDgng: "100.00" }));
    expect(texto(r)).toMatchObject({ creditoDgng: "50.00", resultado: "0.00", situacion: "cero" });
  });

  it("sin compras ni ventas todo es 0.00 y la situación es cero", () => {
    expect(texto(estimarIgv(entrada()))).toEqual({
      igvVentas: "0.00",
      creditoDg: "0.00",
      igvDgng: "0.00",
      creditoDgng: "0.00",
      igvDng: "0.00",
      resultado: "0.00",
      situacion: "cero",
    });
  });
});

describe("estimarIgv: crédito DGNG con la prorrata (R-7)", () => {
  it("prorrata 0.00 → crédito DGNG 0.00 (todo el IGV DGNG es gasto)", () => {
    const r = estimarIgv(entrada({ igvVentas: "100.00", igvDgng: "40.00" }, P0));
    expect(texto(r)).toMatchObject({ creditoDgng: "0.00", resultado: "100.00", situacion: "a_pagar" });
  });

  it("prorrata 100.00 → crédito DGNG = IGV DGNG completo", () => {
    const r = estimarIgv(entrada({ igvVentas: "100.00", igvDgng: "40.00" }, P100));
    expect(texto(r)).toMatchObject({ creditoDgng: "40.00", resultado: "60.00", situacion: "a_pagar" });
  });

  it.each([
    ["0.505 sube al tercer decimal (mitad hacia arriba)", "1.01", "0.51"],
    ["0.515 sube", "1.03", "0.52"],
    ["−0.505 redondea alejándose de cero", "-1.01", "-0.51"],
    ["0.5 no necesita redondeo", "1.00", "0.50"],
  ])("redondeo a céntimos de igvDgng × 50.00 %%: %s", (_n, igvDgng, credito) => {
    expect(String(estimarIgv(entrada({ igvDgng })).creditoDgng)).toBe(credito);
  });

  it("usa el porcentaje ya redondeado, no el cociente exacto: 1/3 → 33.33 %", () => {
    const r = estimarIgv(entrada({ igvDgng: "100.00" }, prorrata("1.00", "3.00")));
    expect(String(r.creditoDgng)).toBe("33.33");
  });

  it("caso mixto real (01 §7.10): IGV 1.61 de la compra mixta en DGNG con 87.34 % → crédito 1.41", () => {
    // 1.61 × 0.8734 = 1.406174 → 1.41
    const r = estimarIgv(entrada({ igvVentas: "10.00", igvDgng: "1.61" }, P8734));
    expect(texto(r)).toMatchObject({ creditoDgng: "1.41", resultado: "8.59", situacion: "a_pagar" });
  });

  it("el IGV DG se acredita completo, sin prorrata", () => {
    const r = estimarIgv(entrada({ igvVentas: "100.00", igvDg: "30.00" }, P0));
    expect(texto(r)).toMatchObject({ creditoDg: "30.00", creditoDgng: "0.00", resultado: "70.00" });
  });
});

describe("estimarIgv: DNG y notas de crédito", () => {
  it("el IGV DNG se devuelve informativo y no resta del resultado", () => {
    const sin = estimarIgv(entrada({ igvVentas: "100.00" }));
    const con = estimarIgv(entrada({ igvVentas: "100.00", igvDng: "500.00" }));
    expect(String(con.igvDng)).toBe("500.00");
    expect(String(con.resultado)).toBe(String(sin.resultado));
    expect(String(con.creditoDg)).toBe("0.00");
    expect(String(con.creditoDgng)).toBe("0.00");
  });

  it("notas de crédito: componentes negativos se restan con su signo (−180 − (−18) − (−5) = −157)", () => {
    const r = estimarIgv(entrada({ igvVentas: "-180.00", igvDg: "-18.00", igvDgng: "-10.00" }));
    expect(texto(r)).toMatchObject({ creditoDg: "-18.00", creditoDgng: "-5.00", resultado: "-157.00", situacion: "saldo_a_favor" });
  });

  it("un crédito DGNG negativo con ventas 0 puede dar a pagar: 0 − 0 − (−0.51) = 0.51", () => {
    const r = estimarIgv(entrada({ igvDgng: "-1.01" }));
    expect(texto(r)).toMatchObject({ creditoDgng: "-0.51", resultado: "0.51", situacion: "a_pagar" });
  });

  it("montos de 12 dígitos: 999999999999.99 − 0.01 − 0.00", () => {
    const r = estimarIgv(entrada({ igvVentas: "999999999999.99", igvDg: "0.01" }));
    expect(texto(r)).toMatchObject({ resultado: "999999999999.98", situacion: "a_pagar" });
  });
});

describe("estimarIgv: entradas inválidas (nunca `number`)", () => {
  it.each(["igvVentas", "igvDg", "igvDgng", "igvDng"] as const)("`%s` como `number` o cadena lanza", (campo) => {
    expect(() => estimarIgv({ ...entrada(), [campo]: 10 } as never)).toThrow();
    expect(() => estimarIgv({ ...entrada(), [campo]: "10.00" } as never)).toThrow();
  });

  it("la prorrata como `number` o cadena lanza", () => {
    expect(() => estimarIgv({ ...entrada(), prorrata: 87.34 } as never)).toThrow();
    expect(() => estimarIgv({ ...entrada(), prorrata: "87.34" } as never)).toThrow();
  });

  it("falta un campo → lanza", () => {
    const incompleta: Record<string, unknown> = { ...entrada() };
    delete incompleta.prorrata;
    expect(() => estimarIgv(incompleta as never)).toThrow();
  });
});

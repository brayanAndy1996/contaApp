// Spec 027 · T1 (rojo). Feriados nacionales 2025–2027 y fin de semana (R-3 S4; plan, Contratos: domain `feriados.ts`).
// `esDiaNoLaborable("AAAA-MM-DD")`: aritmética de calendario, sin reloj ni zona.
import { beforeEach, describe, expect, it } from "vitest";
import { esDiaNoLaborable } from "../index";

/** Un `toThrow()` pasaría con un `TypeError` por export ausente: se exige primero que exista (rojo explícito). */
beforeEach(() => {
  expect(typeof esDiaNoLaborable, "esDiaNoLaborable no está exportada por @contapp/domain").toBe("function");
});

describe("esDiaNoLaborable · feriados fijos de la lista", () => {
  const FIJOS = ["01-01", "05-01", "06-07", "06-29", "07-23", "07-28", "07-29", "08-06", "08-30", "10-08", "11-01", "12-08", "12-09", "12-25"];

  it.each([["2025"], ["2026"], ["2027"]])("los 14 feriados fijos de %s son no laborables (caigan o no en fin de semana)", (anio) => {
    for (const f of FIJOS) expect(esDiaNoLaborable(`${anio}-${f}`), `${anio}-${f}`).toBe(true);
  });

  it("un feriado entre semana: 2026-07-28 (martes) y 2026-05-01 (viernes)", () => {
    expect(esDiaNoLaborable("2026-07-28")).toBe(true);
    expect(esDiaNoLaborable("2026-05-01")).toBe(true);
    expect(esDiaNoLaborable("2026-06-29")).toBe(true); // lunes
  });

  it("el día anterior y posterior de un feriado entre semana son laborables", () => {
    expect(esDiaNoLaborable("2026-07-27")).toBe(false); // lunes
    expect(esDiaNoLaborable("2026-07-30")).toBe(false); // jueves
    expect(esDiaNoLaborable("2026-06-30")).toBe(false); // martes
  });
});

describe("esDiaNoLaborable · Jueves y Viernes Santo", () => {
  it.each([
    ["2025-04-17"], ["2025-04-18"],
    ["2026-04-02"], ["2026-04-03"],
    ["2027-03-25"], ["2027-03-26"],
  ])("%s es no laborable", (f) => {
    expect(esDiaNoLaborable(f)).toBe(true);
  });

  it("el miércoles previo y el lunes posterior son laborables", () => {
    expect(esDiaNoLaborable("2025-04-16")).toBe(false);
    expect(esDiaNoLaborable("2026-04-01")).toBe(false);
    expect(esDiaNoLaborable("2026-04-06")).toBe(false);
    expect(esDiaNoLaborable("2027-03-24")).toBe(false);
  });
});

describe("esDiaNoLaborable · fin de semana y días hábiles", () => {
  it("sábado y domingo", () => {
    expect(esDiaNoLaborable("2026-03-14")).toBe(true);
    expect(esDiaNoLaborable("2026-03-15")).toBe(true);
    expect(esDiaNoLaborable("2026-11-22")).toBe(true);
  });

  it("un miércoles y un lunes comunes son laborables", () => {
    expect(esDiaNoLaborable("2026-03-11")).toBe(false);
    expect(esDiaNoLaborable("2026-06-08")).toBe(false);
    expect(esDiaNoLaborable("2026-06-10")).toBe(false);
  });
});

describe("esDiaNoLaborable · años sin lista (solo fin de semana)", () => {
  it("2028: sábado sí; el feriado nacional que cae lunes y Jueves Santo no cuentan", () => {
    expect(esDiaNoLaborable("2028-03-11")).toBe(true); // sábado
    expect(esDiaNoLaborable("2028-12-23")).toBe(true); // sábado
    expect(esDiaNoLaborable("2028-12-25")).toBe(false); // lunes, Navidad
    expect(esDiaNoLaborable("2028-04-13")).toBe(false); // Jueves Santo
  });

  it("2024: Navidad un miércoles no cuenta", () => {
    expect(esDiaNoLaborable("2024-12-25")).toBe(false);
  });
});

describe("esDiaNoLaborable · fechas inválidas lanzan", () => {
  it.each([
    ["2026-02-30"], ["2026-13-01"], ["2026-00-10"], ["2026-01-00"], ["2026-04-31"], ["2025-02-29"], ["26-01-01"], ["2026-1-1"],
    ["2026/01/01"], ["20260101"], [""], [" 2026-01-01"], ["2026-01-01 "], ["2026-01-01T00:00:00Z"], ["abcd-ef-gh"],
  ])("%j", (f) => {
    expect(() => esDiaNoLaborable(f)).toThrow();
  });

  it("2028-02-29 (bisiesto) es válida y 2026-02-29 no", () => {
    expect(() => esDiaNoLaborable("2028-02-29")).not.toThrow();
    expect(() => esDiaNoLaborable("2026-02-29")).toThrow();
  });
});

// Spec 026 · T1 (rojo). ventanaProrrata(periodo) → 12 periodos AAAAMM de M−11 a M (R-1, U-1; CA-1).
// Contrato (plan 026, Contratos: domain): periodo inválido → error de dominio (lanza); nunca `number`.
import { describe, expect, it } from "vitest";
import { VENTANA_202610, ventanaOraculo } from "../../tests/ayudas/prorrata";
import { ventanaProrrata } from "./ventana";

describe("ventanaProrrata", () => {
  it("2026-10 → 2025-11 a 2026-10, en orden, incluido el mes M (R-1, U-1)", () => {
    const v = ventanaProrrata("202610");
    expect(v).toEqual([
      "202511", "202512", "202601", "202602", "202603", "202604",
      "202605", "202606", "202607", "202608", "202609", "202610",
    ]);
    expect(v).toEqual(VENTANA_202610);
  });

  it("cruza el año: 2026-02 → 2025-03 a 2026-02", () => {
    expect(ventanaProrrata("202602")).toEqual([
      "202503", "202504", "202505", "202506", "202507", "202508",
      "202509", "202510", "202511", "202512", "202601", "202602",
    ]);
  });

  it("enero: 2026-01 → 2025-02 a 2026-01 (el año anterior completo salvo enero)", () => {
    const v = ventanaProrrata("202601");
    expect(v[0]).toBe("202502");
    expect(v[10]).toBe("202512");
    expect(v[11]).toBe("202601");
    expect(v).toHaveLength(12);
  });

  it("diciembre: 2026-12 → 2026-01 a 2026-12 (todo el año)", () => {
    const v = ventanaProrrata("202612");
    expect(v[0]).toBe("202601");
    expect(v[11]).toBe("202612");
  });

  it("cruza el 29 de febrero y los siglos sin saltarse ni repetir meses", () => {
    expect(ventanaProrrata("202402")[0]).toBe("202303");
    expect(ventanaProrrata("210001")[0]).toBe("209902");
  });

  it("para todo periodo válido 2000-01..2099-12: 12 meses distintos, consecutivos, el último es M y coincide con el oráculo", () => {
    for (let a = 2000; a <= 2099; a++) {
      for (let m = 1; m <= 12; m++) {
        const periodo = `${a}${String(m).padStart(2, "0")}`;
        const v = ventanaProrrata(periodo);
        expect(v).toHaveLength(12);
        expect(new Set(v).size).toBe(12);
        expect(v[11]).toBe(periodo);
        expect(v).toEqual(ventanaOraculo(periodo));
        for (const p of v) expect(p).toMatch(/^[0-9]{4}(0[1-9]|1[0-2])$/);
      }
    }
  });

  it("no muta ni comparte estado: dos llamadas dan listas iguales e independientes", () => {
    const a = ventanaProrrata("202610");
    const b = ventanaProrrata("202610");
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    a.pop();
    expect(ventanaProrrata("202610")).toHaveLength(12);
  });

  it.each([
    ["mes 13", "202613"],
    ["mes 00", "202600"],
    ["con guion (formato de pantalla)", "2026-10"],
    ["corto", "20261"],
    ["largo", "2026100"],
    ["vacío", ""],
    ["letras", "abcdef"],
    ["espacio inicial", " 202610"],
    ["salto de línea final", "202610\n"],
    ["dígitos de ancho completo", "２０２６１０"],
    ["signo", "+202610"],
    ["exponente", "2.0e5"],
    ["decimal", "2026.10"],
  ])("periodo inválido (%s) lanza", (_n, periodo) => {
    expect(() => ventanaProrrata(periodo)).toThrow();
  });

  it.each([
    ["number", 202610],
    ["null", null],
    ["undefined", undefined],
    ["objeto", {}],
    ["arreglo", ["202610"]],
    ["bigint", 202610n],
  ])("un %s no es periodo: lanza (nunca `number`)", (_n, valor) => {
    expect(() => ventanaProrrata(valor as never)).toThrow();
  });
});

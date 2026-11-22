// Spec 026 · T1 (rojo). compararProrrata(calculada: Porcentaje, usada: string) → {diferencia, alerta} (R-8, U-9, U-10; CA-6, RF-135).
// Contrato (plan 026): alerta si |calculada − usada| ≥ 0.01 puntos; `usada` con la gramática
// ^(100(\.0{1,2})?|[0-9]{1,2}(\.[0-9]{1,2})?)$ (por eso una diferencia de 0.009 es imposible); `diferencia` es una cadena de
// 2 decimales (esta prueba compara su valor absoluto: el contrato no fija el signo).
import { describe, expect, it } from "vitest";
import { pen } from "../../tests/ayudas/prorrata";
import { compararProrrata } from "./diferencia";
import { porcentajeProrrata } from "./porcentaje";

const calculada = (n: string, t: string) => porcentajeProrrata(pen(n), pen(t));
const C8734 = calculada("87340.00", "100000.00"); // 87.34
const absoluta = (d: string) => d.replace(/^-/, "");

describe("compararProrrata: alerta con diferencia ≥ 0.01 puntos (U-10)", () => {
  it("igual → sin alerta y diferencia 0.00", () => {
    const r = compararProrrata(C8734, "87.34");
    expect(r.alerta).toBe(false);
    expect(absoluta(r.diferencia)).toBe("0.00");
  });

  it("0.01 por debajo → alerta (el mínimo que alerta)", () => {
    const r = compararProrrata(C8734, "87.33");
    expect(r.alerta).toBe(true);
    expect(absoluta(r.diferencia)).toBe("0.01");
  });

  it("0.01 por encima → alerta (el valor absoluto, no el signo)", () => {
    const r = compararProrrata(C8734, "87.35");
    expect(r.alerta).toBe(true);
    expect(absoluta(r.diferencia)).toBe("0.01");
  });

  it("diferencia grande: 87.34 contra 50.00 → 37.34", () => {
    const r = compararProrrata(C8734, "50.00");
    expect(r.alerta).toBe(true);
    expect(absoluta(r.diferencia)).toBe("37.34");
  });

  it("la gramática admite 0, 1 o 2 decimales: «87.3» es 87.30 (diferencia 0.04) y «87» es 87.00", () => {
    expect(absoluta(compararProrrata(C8734, "87.3").diferencia)).toBe("0.04");
    expect(absoluta(compararProrrata(C8734, "87").diferencia)).toBe("0.34");
  });

  it("extremos 0 y 100: 100.00 calculado contra «100», «100.0» y «100.00» → sin alerta; contra «99.99» → alerta", () => {
    const cien = calculada("500.00", "500.00");
    for (const usada of ["100", "100.0", "100.00"]) {
      const r = compararProrrata(cien, usada);
      expect(r.alerta, usada).toBe(false);
      expect(absoluta(r.diferencia), usada).toBe("0.00");
    }
    expect(compararProrrata(cien, "99.99").alerta).toBe(true);
    const cero = calculada("0.00", "500.00");
    expect(compararProrrata(cero, "0").alerta).toBe(false);
    expect(compararProrrata(cero, "0.00").alerta).toBe(false);
    expect(compararProrrata(cero, "0.01").alerta).toBe(true);
  });

  it("la diferencia siempre tiene 2 decimales", () => {
    for (const usada of ["0", "5.5", "87.34", "100"]) {
      expect(compararProrrata(C8734, usada).diferencia).toMatch(/^-?[0-9]{1,3}\.[0-9]{2}$/);
    }
  });
});

describe("compararProrrata: `usada` inválida lanza (gramática de U-9)", () => {
  it.each([
    ["3 decimales (0.009 imposible)", "87.345"],
    ["más de 100", "100.01"],
    ["101", "101"],
    ["100.1 (un decimal sobre 100)", "100.1"],
    ["negativa", "-1"],
    ["vacía", ""],
    ["texto", "abc"],
    ["coma decimal", "87,34"],
    ["exponente", "1e2"],
    ["espacio inicial", " 87.34"],
    ["espacio final", "87.34 "],
    ["punto sin decimales", "87."],
    ["sin entero", ".5"],
    ["signo más", "+87.34"],
    ["3 enteros que no son 100", "099.00"],
    ["salto de línea final", "87.34\n"],
    ["dígitos de ancho completo", "８７.３４"],
  ])("%s → %j", (_n, usada) => {
    expect(() => compararProrrata(C8734, usada)).toThrow();
  });

  it.each([
    ["number", 87.34],
    ["number entero", 87],
    ["null", null],
    ["undefined", undefined],
    ["objeto", { valor: "87.34" }],
  ])("`usada` %s lanza (nunca `number`)", (_n, usada) => {
    expect(() => compararProrrata(C8734, usada as never)).toThrow();
  });

  it("`calculada` que no es un Porcentaje (cadena o number) lanza", () => {
    expect(() => compararProrrata("87.34" as never, "87.34")).toThrow();
    expect(() => compararProrrata(87.34 as never, "87.34")).toThrow();
    expect(() => compararProrrata(null as never, "87.34")).toThrow();
  });
});

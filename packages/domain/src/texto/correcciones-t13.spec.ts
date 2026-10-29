// T13 (backend): R1b-7. Un punto al final de una palabra completa es separador; las abreviaturas
// con punto siguen valiendo y "zapat.dep." se parte en dos (decisión del usuario).
import { describe, expect, it } from "vitest";
import { DICCIONARIO_GLOSAS_BASE, tokensDeGlosa } from "../index";

describe("R1b-7: tokensDeGlosa con puntos pegados", () => {
  it("un punto seguido de letra cierra el token; el punto interior de un número se conserva", () => {
    expect(tokensDeGlosa("ZAPAT.DEP. T-42")).toEqual(["zapat.", "dep.", "t", "42"]);
    expect(tokensDeGlosa("1.50 und.x")).toEqual(["1.50", "und.", "x"]);
  });
});

describe("R1b-7: coincidencia de palabra completa con punto final", () => {
  it.each([
    ["COMPRA DE ZAPATILLAS.", "zapatilla"],
    ["perfume.", "perfume"],
    ["ZAPAT.DEP.", "zapatilla"],
  ])("%s → %s", (glosa, palabra) => {
    expect(DICCIONARIO_GLOSAS_BASE.buscar([glosa])?.palabra).toBe(palabra);
  });

  it.each([["zapatillasx."], ["zap.dep."], ["perfumeria."]])("%s no coincide", (glosa) => {
    expect(DICCIONARIO_GLOSAS_BASE.buscar([glosa])).toBeNull();
  });
});

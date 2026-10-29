// T15 (backend): R2a-5 = R2b-4 + R2b-5. Decisión del usuario sobre R1b-7: un punto al final de
// una palabra completa separa (también ante dígitos y repetido o "…"); "zapat." sigue siendo
// abreviatura y el punto entre dígitos se conserva ("1.50").
import { describe, expect, it } from "vitest";
import { DICCIONARIO_GLOSAS_BASE, tokensDeGlosa } from "../index";

describe("T15: tokensDeGlosa con puntos ante dígitos, repetidos y al final", () => {
  it.each([
    ["ZAPATILLAS.38 NEGRAS", ["zapatillas.", "38", "negras"]],
    ["PERFUME.100ML", ["perfume.", "100ml"]],
    ["ZAPAT... DEP", ["zapat.", "dep"]],
    ["PERFUMES… IMPORTADOS", ["perfumes.", "importados"]],
    ["zapata de concreto 1.50.", ["zapata", "de", "concreto", "1.50"]],
    ["100.ml .5 1..5", ["100", "ml", "5", "1", "5"]],
  ])("%s → %j", (glosa, tokens) => {
    expect(tokensDeGlosa(glosa)).toEqual(tokens);
  });
});

describe("T15: coincidencias con el diccionario base", () => {
  it.each([
    ["ZAPATILLAS.38", "zapatilla"],
    ["PERFUME.100ML", "perfume"],
    ["ZAPAT.42 URBANA", "zapatilla"],
    ["COMPRA DE ZAPATILLAS...", "zapatilla"],
  ])("%s → %s", (glosa, palabra) => {
    expect(DICCIONARIO_GLOSAS_BASE.buscar([glosa])?.palabra).toBe(palabra);
  });

  it.each([["ZAPATA.40"], ["zapata de concreto 1.50"], ["zap...dep"]])("%s no coincide", (glosa) => {
    expect(DICCIONARIO_GLOSAS_BASE.buscar([glosa])).toBeNull();
  });
});

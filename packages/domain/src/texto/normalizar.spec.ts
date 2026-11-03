import { beforeEach, describe, expect, it } from "vitest";
import * as dominio from "../index";

// Spec 011, D-5 y CA-12: normalización simple de glosas (minúsculas, sin tildes,
// separadores, abreviaturas con punto). Contrato: plan 011, "texto/".

interface ApiNormalizar {
  tokensDeGlosa: (glosa: string) => readonly string[];
}
const api = dominio as unknown as Partial<ApiNormalizar>;
const tokens = (g: string): readonly string[] =>
  (api.tokensDeGlosa as ApiNormalizar["tokensDeGlosa"])(g);

/** Si la API pública aún no exporta algo, TODA prueba falla por esa razón (rojo explícito). */
beforeEach(() => {
  expect(
    typeof api.tokensDeGlosa,
    "tokensDeGlosa no está exportada por @contapp/domain",
  ).toBe("function");
});

describe("tokensDeGlosa: tildes, mayúsculas y símbolos", () => {
  it("pasa a minúsculas y separa por espacios (CA-12 'ZAPATILLAS URBANAS T-42')", () => {
    expect(tokens("ZAPATILLAS URBANAS T-42")).toEqual([
      "zapatillas",
      "urbanas",
      "t",
      "42",
    ]);
  });

  it("quita tildes: 'Zapatíllas' == 'zapatillas'", () => {
    expect(tokens("Zapatíllas")).toEqual(["zapatillas"]);
    expect(tokens("Zapatíllas")).toEqual(tokens("ZAPATILLAS"));
  });

  it("quita la tilde de la eñe y la diéresis (NFKD sin marcas)", () => {
    expect(tokens("MUÑECA")).toEqual(["muneca"]);
    expect(tokens("pingüino")).toEqual(["pinguino"]);
  });

  it("NFKD: caracteres de ancho completo se pasan a ASCII", () => {
    expect(tokens("ＺＡＰＡＴＩＬＬＡ")).toEqual(["zapatilla"]);
  });

  it("conserva dígitos y el punto interior de un número", () => {
    expect(tokens("Total 1.50 und")).toEqual(["total", "1.50", "und"]);
  });
});

describe("tokensDeGlosa: separadores", () => {
  it.each([
    ["barra vertical", "zapatilla|perfume"],
    ["salto de línea", "zapatilla\nperfume"],
    ["CRLF", "zapatilla\r\nperfume"],
    ["tabulación", "zapatilla\tperfume"],
    ["NBSP", "zapatilla perfume"],
    ["coma y punto y coma", "zapatilla,;perfume"],
    ["varios separadores seguidos", "  zapatilla \t\n |   perfume  "],
  ])("separa por %s", (_n, glosa) => {
    expect(tokens(glosa)).toEqual(["zapatilla", "perfume"]);
  });
});

describe("tokensDeGlosa: abreviaturas (punto final)", () => {
  it("un punto final marca abreviatura y se conserva en el token", () => {
    expect(tokens("zapat. dep.")).toEqual(["zapat.", "dep."]);
  });

  it("el punto final pegado a un separador se conserva", () => {
    expect(tokens("ZAPAT.|DEP.")).toEqual(["zapat.", "dep."]);
  });

  it("una palabra sin punto final no es abreviatura", () => {
    expect(tokens("zapat")).toEqual(["zapat"]);
  });
});

describe("tokensDeGlosa: casos vacíos y límites", () => {
  it("cadena vacía → sin tokens", () => {
    expect(tokens("")).toEqual([]);
  });

  it("solo separadores → sin tokens", () => {
    expect(tokens(" \t\n |,;")).toEqual([]);
  });

  it("determinista: la misma glosa produce los mismos tokens", () => {
    const g = "Zapatíllas|URBANAS\tT-42 zapat.";
    expect(tokens(g)).toEqual(tokens(g));
  });

  it("glosa de 1 MB (palabras) en menos de 1 s", () => {
    const glosa = "producto ".repeat(125_000); // ~1 MB
    const t0 = Date.now();
    const r = tokens(glosa);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.length).toBe(125_000);
  });

  it.each([
    ["una sola palabra de 1 MB", "x".repeat(1_000_000)],
    ["1 MB de puntos", ".".repeat(1_000_000)],
    ["1 MB de separadores", "|".repeat(1_000_000)],
    ["1 MB de letras con tilde", "í".repeat(500_000)],
  ])("sin retroceso patológico: %s en menos de 1 s", (_n, glosa) => {
    const t0 = Date.now();
    tokens(glosa);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

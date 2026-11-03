// T12b (adversario · opus): ronda adversarial 1b de 011, texto/ (caja blanca).
// Solo API pública de @contapp/domain. Deterministas: sin reloj ni azar.
import { describe, expect, it } from "vitest";
import { DICCIONARIO_GLOSAS_BASE } from "../index";

describe("R1b-7 glosas con puntuación pegada, Unicode y tamaño (D-5, CA-12, ataques: Unicode/ReDoS)", () => {
  // D-5: "minúsculas, sin tildes, plural simple, abreviaturas con punto". CA-12: "zapat. dep."
  // dispara. Los casos con punto pegado a un plural o a otra abreviatura son `decide usuario`
  // si se lee el plan al pie de la letra ("un punto final marca abreviatura").
  it.each([
    ["plural al final de una oración", "COMPRA DE ZAPATILLAS.", "zapatilla"],
    ["plural con punto", "PERFUMES.", "perfume"],
    ["abreviaturas pegadas", "ZAPAT.DEP. T-42", "zapatilla"],
    ["ancho completo", "ＺＡＰＡＴＩＬＬＡＳ", "zapatilla"],
    ["I con punto turca", "ZAPATİLLA URBANA", "zapatilla"],
    ["negrita matemática", "𝐙𝐀𝐏𝐀𝐓𝐈𝐋𝐋𝐀", "zapatilla"],
    ["marcas combinantes en masa (lineal)", `a${"́".repeat(500_000)} zapatillas`, "zapatilla"],
  ])("%s → R-GP con la palabra del diccionario", (_n, glosa, palabra) => {
    expect(DICCIONARIO_GLOSAS_BASE.buscar([glosa])?.palabra).toBe(palabra);
  });
});

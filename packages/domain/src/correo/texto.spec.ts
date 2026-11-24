// Spec 028 · T1 (rojo). `escaparHtml` y `limpiarLinea` (R-6, CA-7; plan, Contratos: domain `texto.ts`).
// Contratos fijados por T1 que el plan no precisa (anotados en el resultado de la tarea):
//  - `escaparHtml` solo escapa `& < > " '` (`&amp; &lt; &gt; &quot; &#39;`); no quita nada más.
//  - `limpiarLinea(s, max)`: el resultado mide como máximo `max` puntos de código INCLUIDO el «…» final cuando recorta
//    (300 «a» con max 60 → 59 «a» + «…»); CR, LF y tabulador pasan a espacio o se quitan (ambas formas valen), NUL y demás controles
//    (\p{Cc}) y el formato invisible (\p{Cf}: bidi, ancho cero) se quitan; los espacios se colapsan y los extremos se recortan.
import { describe, expect, it } from "vitest";
import { escaparHtml, limpiarLinea } from "../index";

describe("escaparHtml · CA-7", () => {
  it.each([
    ["&", "&amp;"],
    ["<", "&lt;"],
    [">", "&gt;"],
    ['"', "&quot;"],
    ["'", "&#39;"],
  ])("escapa %s → %s", (entrada, esperado) => {
    expect(escaparHtml(entrada)).toBe(esperado);
  });

  it("«<img src=x onerror=alert(1)>» no deja ninguna etiqueta", () => {
    const r = escaparHtml("<img src=x onerror=alert(1)>");
    expect(r).toBe("&lt;img src=x onerror=alert(1)&gt;");
    expect(r).not.toMatch(/[<>]/);
  });

  it("escapa en una sola pasada (el «&» de una entidad ya escrita también se escapa)", () => {
    expect(escaparHtml("&lt;")).toBe("&amp;lt;");
    expect(escaparHtml(`a & "b" 'c' <d>`)).toBe("a &amp; &quot;b&quot; &#39;c&#39; &lt;d&gt;");
  });

  it("texto sin caracteres especiales, tildes y eñes pasan igual", () => {
    expect(escaparHtml("Distribuidora Peñafiel Ñandú SAC")).toBe("Distribuidora Peñafiel Ñandú SAC");
    expect(escaparHtml("")).toBe("");
  });
});

describe("limpiarLinea · CA-7", () => {
  it("texto normal pasa igual", () => {
    expect(limpiarLinea("Distribuidora Andina SAC", 60)).toBe("Distribuidora Andina SAC");
  });

  it("quita NUL y otros controles", () => {
    expect(limpiarLinea("SU\u0000NAT\u0007", 60)).toBe("SUNAT");
    expect(limpiarLinea("a\u0000b", 60)).toBe("ab");
    expect(limpiarLinea("a\u007fb\u001bc", 60)).toBe("abc");
  });

  it("quita el formato bidi y de ancho cero (\u202e, \u200b, \u2066, BOM)", () => {
    expect(limpiarLinea("a\u202eb", 60)).toBe("ab");
    expect(limpiarLinea("a\u200bb\u2066c\ufeffd", 60)).toBe("abcd");
  });

  it("CR y LF no sobreviven: «\\r\\nBcc: x@y» no puede abrir una cabecera", () => {
    const r = limpiarLinea("ACME\r\nBcc: x@y", 60);
    expect(r).not.toMatch(/[\r\n]/);
    expect(r).toMatch(/^ACME ?Bcc: x@y$/);
    expect(limpiarLinea("a\nb\rc\td", 60)).toMatch(/^a ?b ?c ?d$/);
  });

  it("colapsa espacios repetidos y recorta los extremos", () => {
    expect(limpiarLinea("  Estudio   Quispe    SAC  ", 60)).toBe("Estudio Quispe SAC");
  });

  it("300 caracteres → 59 + «…» (60 en total)", () => {
    const r = limpiarLinea("a".repeat(300), 60);
    expect(r).toBe(`${"a".repeat(59)}…`);
    expect(Array.from(r)).toHaveLength(60);
  });

  it("justo en el máximo no recorta; uno más sí", () => {
    expect(limpiarLinea("b".repeat(60), 60)).toBe("b".repeat(60));
    expect(limpiarLinea("b".repeat(61), 60)).toBe(`${"b".repeat(59)}…`);
  });

  it("respeta el máximo recibido", () => {
    expect(limpiarLinea("abcdefghij", 5)).toBe("abcd…");
  });

  it("cuenta puntos de código: no parte un emoji por la mitad", () => {
    const r = limpiarLinea("😀".repeat(100), 60);
    expect(Array.from(r)).toHaveLength(60);
    expect(r.endsWith("…")).toBe(true);
    expect(r).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });

  it("limpia antes de contar: los invisibles no gastan el máximo", () => {
    expect(limpiarLinea(`${"\u200b".repeat(100)}${"c".repeat(60)}`, 60)).toBe("c".repeat(60));
  });

  it("«<img src=x onerror=…>» no se altera aquí (el escapado es de escaparHtml)", () => {
    expect(limpiarLinea("<img src=x onerror=alert(1)>", 60)).toBe("<img src=x onerror=alert(1)>");
  });

  it("solo invisibles → vacío", () => {
    expect(limpiarLinea("\u0000\u200b\u202e \r\n", 60)).toBe("");
  });
});

import { describe, expect, it } from "vitest";
import { saltoJustificarSchema } from "./esquemas.js";

// Spec 013 T18 · H-013-3 (rojo hasta T19): el comentario de una justificación (D8) es el único texto libre de las rutas de
// ventas y PostgreSQL rechaza el NUL en `text` (500 `error_interno`). El esquema rechaza los caracteres de control
// (categoría Unicode Cc: C0, DEL y C1) para que la ruta responda 400. Saltos de línea y tabulación no se fijan aquí: la
// spec no los decide; solo se fija que ningún otro carácter de control entre.
const base = { tipo: "03", serie: "B001", desde: 291, hasta: 291, comentario: "Boleta anulada en caja" };
const con = (comentario: string) => saltoJustificarSchema.safeParse({ ...base, comentario });

describe("H-013-3 · saltoJustificarSchema rechaza los caracteres de control del comentario", () => {
  it.each([
    ["NUL (U+0000)", "anulada\u0000por error"],
    ["SOH (U+0001)", "\u0001anulada"],
    ["BEL (U+0007)", "anulada\u0007"],
    ["backspace (U+0008)", "anul\u0008ada"],
    ["tabulación vertical (U+000B)", "anulada\u000bpor error"],
    ["salto de página (U+000C)", "anulada\u000cpor error"],
    ["ESC (U+001B)", "\u001b[31manulada"],
    ["US (U+001F)", "anulada\u001fpor error"],
    ["DEL (U+007F)", "anulada\u007f"],
    ["NEL, de control C1 (U+0085)", "anulada\u0085por error"],
    ["APC, de control C1 (U+009F)", "anulada\u009f"],
  ])("%s: rechazado", (_nombre, comentario) => {
    expect(con(comentario).success).toBe(false);
  });

  it("un control no se salva por venir con texto válido alrededor ni por el recorte de espacios", () => {
    expect(con("  \u0000  ").success).toBe(false);
    expect(con("a".repeat(499) + "\u0000").success).toBe(false);
  });

  it("el rechazo cuelga del campo `comentario`", () => {
    const r = con("anulada\u0000");
    expect(r.success).toBe(false);
    expect(r.error?.issues.some((i) => i.path[0] === "comentario")).toBe(true);
  });

  it("acepta texto normal: tildes, ñ, comas, comillas, emoji, guiones y el máximo de 500 caracteres", () => {
    for (const c of [
      "Boleta anulada en caja",
      "Anulación nº 3 — «cliente» pidió cambio, S/ 118.00; ver 'acta' \"2026\"",
      "Se anuló por error de digitación ✔",
      "a".repeat(500),
    ]) {
      const r = con(c);
      expect(r.success, c.slice(0, 40)).toBe(true);
      expect(r.data?.comentario).toBe(c);
    }
  });

  it("las reglas anteriores siguen: vacío, solo espacios y más de 500 caracteres se rechazan", () => {
    expect(con("").success).toBe(false);
    expect(con("   ").success).toBe(false);
    expect(con("a".repeat(501)).success).toBe(false);
  });
});

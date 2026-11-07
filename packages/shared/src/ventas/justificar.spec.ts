import { describe, expect, it } from "vitest";
import { saltoJustificarSchema } from "./esquemas.js";

// Spec 013 (D8; CA-7; plan: Rutas, `POST /saltos-justificados`). Contrato fijado por estas pruebas:
//  - saltoJustificarSchema: { tipo (2 dígitos), serie (1 a 4 alfanuméricos), desde y hasta (enteros JSON de
//    1 a 99999999, es decir 1 a 8 dígitos; `desde <= hasta`), comentario (1 a 500 caracteres, no solo espacios) }.
//  - Claves desconocidas descartadas (usuarioId, revertidoPor, clienteId...).
//  - Que el rango esté dentro de un faltante actual lo decide el servicio (400), no el esquema.
const base = { tipo: "03", serie: "B001", desde: 291, hasta: 291, comentario: "Boleta anulada en caja" };
const ok = (v: unknown) => saltoJustificarSchema.safeParse(v).success;
const con = (cambios: Record<string, unknown>) => ({ ...base, ...cambios });

describe("saltoJustificarSchema", () => {
  it("acepta la justificación de la 291 y la devuelve igual", () => {
    const r = saltoJustificarSchema.safeParse(base);
    expect(r.success).toBe(true);
    expect(r.data).toEqual(base);
  });

  it("acepta un rango (B003-402 a B003-404) y desde = hasta", () => {
    expect(ok(con({ serie: "B003", desde: 402, hasta: 404 }))).toBe(true);
    expect(ok(con({ desde: 5, hasta: 5 }))).toBe(true);
  });

  it("acepta los extremos de 1 y de 8 dígitos", () => {
    expect(ok(con({ desde: 1, hasta: 1 }))).toBe(true);
    expect(ok(con({ desde: 99_999_999, hasta: 99_999_999 }))).toBe(true);
    expect(ok(con({ desde: 1, hasta: 99_999_999 }))).toBe(true);
  });

  it("rechaza desde > hasta", () => {
    expect(ok(con({ desde: 292, hasta: 291 }))).toBe(false);
    expect(ok(con({ desde: 99_999_999, hasta: 1 }))).toBe(false);
  });

  it.each([
    ["cero", 0],
    ["negativo", -1],
    ["decimal", 291.5],
    ["9 dígitos", 100_000_000],
    ["cadena", "291"],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["entero inseguro", Number.MAX_SAFE_INTEGER + 2],
    ["null", null],
    ["texto", "abc"],
  ])("rechaza desde = %s", (_c, desde) => {
    expect(ok(con({ desde, hasta: 99_999_999 }))).toBe(false);
  });

  it.each([
    ["cero", 0],
    ["negativo", -1],
    ["decimal", 291.5],
    ["9 dígitos", 100_000_000],
    ["cadena", "291"],
    ["NaN", NaN],
    ["null", null],
  ])("rechaza hasta = %s", (_c, hasta) => {
    expect(ok(con({ desde: 1, hasta }))).toBe(false);
  });

  it("exige desde y hasta", () => {
    expect(ok({ tipo: "03", serie: "B001", hasta: 291, comentario: "x" })).toBe(false);
    expect(ok({ tipo: "03", serie: "B001", desde: 291, comentario: "x" })).toBe(false);
  });

  it("el comentario va de 1 a 500 caracteres", () => {
    expect(ok(con({ comentario: "a" }))).toBe(true);
    expect(ok(con({ comentario: "a".repeat(500) }))).toBe(true);
    expect(ok(con({ comentario: "a".repeat(501) }))).toBe(false);
    expect(ok(con({ comentario: "a".repeat(100_000) }))).toBe(false);
  });

  it.each([
    ["vacío", ""],
    ["solo espacios", "   "],
    ["solo saltos de línea y tabulaciones", "\n\t \n"],
    ["número", 5],
    ["null", null],
    ["objeto", {}],
    ["arreglo", ["x"]],
  ])("rechaza un comentario %s (sin comentario es 400)", (_c, comentario) => {
    expect(ok(con({ comentario }))).toBe(false);
  });

  it("exige el comentario", () => {
    const sinComentario: Record<string, unknown> = { ...base };
    delete sinComentario.comentario;
    expect(ok(sinComentario)).toBe(false);
  });

  it("conserva el comentario tal cual (comillas, `%` y acentos no se alteran)", () => {
    const comentario = "Anulada: 'duplicada' 100% — ñandú";
    const r = saltoJustificarSchema.safeParse(con({ comentario }));
    expect(r.success).toBe(true);
    expect((r.data as { comentario: string }).comentario).toBe(comentario);
  });

  it.each(["", "3", "003", "0a", "0%"])("rechaza el tipo %j", (tipo) => {
    expect(ok(con({ tipo }))).toBe(false);
  });
  it.each(["", "B0001", "B%01", "B_01", "B'01", "B-01"])("rechaza la serie %j", (serie) => {
    expect(ok(con({ serie }))).toBe(false);
  });
  it("exige tipo y serie", () => {
    expect(ok({ desde: 1, hasta: 1, comentario: "x", serie: "B001" })).toBe(false);
    expect(ok({ desde: 1, hasta: 1, comentario: "x", tipo: "03" })).toBe(false);
  });

  it("descarta las claves desconocidas", () => {
    const r = saltoJustificarSchema.safeParse(
      con({ usuarioId: "u", revertidoPor: "u", revertidoEn: "2026-10-01", clienteId: "c", tenantId: "t", id: "i" }),
    );
    expect(r.success).toBe(true);
    expect(r.data).toEqual(base);
  });
});

import { describe, expect, it } from "vitest";
import { normalizarCorreo } from "./correo.js";

// D10 (spec 004): el correo se normaliza con trim -> minúsculas -> NFC, en este orden y sin
// otras transformaciones. Contrato: `normalizarCorreo(correo: string): string`, función pura.
describe("normalizarCorreo", () => {
  it("quita espacios al inicio y al final", () => {
    expect(normalizarCorreo("  ana@estudio.pe  ")).toBe("ana@estudio.pe");
  });

  it("quita tabuladores, saltos de línea y espacio no separable en los extremos", () => {
    expect(normalizarCorreo("\t\n ana@estudio.pe \r\n")).toBe("ana@estudio.pe");
    expect(normalizarCorreo(" ana@estudio.pe ")).toBe("ana@estudio.pe");
  });

  it("pasa a minúsculas", () => {
    expect(normalizarCorreo("Ana.Perez@Estudio.PE")).toBe("ana.perez@estudio.pe");
  });

  it("no toca los espacios interiores (no los elimina)", () => {
    expect(normalizarCorreo("a b@estudio.pe")).toBe("a b@estudio.pe");
  });

  it("compone a NFC: 'e' + acento combinante equivale al carácter compuesto", () => {
    const descompuesto = "café@estudio.pe";
    const compuesto = "café@estudio.pe";
    expect(normalizarCorreo(descompuesto)).toBe(compuesto);
    expect(normalizarCorreo(compuesto)).toBe(compuesto);
  });

  it("minúscula y NFC se combinan: 'E' + acento combinante -> 'é' compuesta", () => {
    expect(normalizarCorreo("É@estudio.pe")).toBe("é@estudio.pe");
  });

  it("el signo Kelvin (U+212A) queda como 'k' ASCII", () => {
    expect(normalizarCorreo("Kelvin@estudio.pe")).toBe("kelvin@estudio.pe");
  });

  it("es idempotente", () => {
    const entradas = ["  Ana@Estudio.PE ", "CAFÉ@X.PE", "K@x.pe", "plano@estudio.pe"];
    for (const e of entradas) {
      const una = normalizarCorreo(e);
      expect(normalizarCorreo(una)).toBe(una);
    }
  });

  it("variantes de mayúsculas y espacios del mismo correo dan el mismo resultado", () => {
    const variantes = ["ana@estudio.pe", "ANA@ESTUDIO.PE", " Ana@Estudio.Pe", "ana@estudio.pe\t"];
    expect(new Set(variantes.map(normalizarCorreo)).size).toBe(1);
  });

  it("una cadena vacía o de solo espacios queda vacía", () => {
    expect(normalizarCorreo("")).toBe("");
    expect(normalizarCorreo("   ")).toBe("");
  });
});

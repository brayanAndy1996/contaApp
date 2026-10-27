import { describe, expect, it } from "vitest";
import { CorreoNoAsciiError, normalizarCorreo } from "./correo.js";

// D10 (spec 004): el correo se normaliza con trim -> minúsculas -> NFC, en este orden y sin
// otras transformaciones. Contrato: `normalizarCorreo(correo: string): string`, función pura; desde
// T16 (decisión del usuario) lanza CorreoNoAsciiError si el resultado no es ASCII.
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

  // T16 (decisión del usuario, H-r1b-4): los correos son solo ASCII (dominios internacionales en
  // punycode). Antes estas dos pruebas fijaban que "café"/"É" se componían a NFC y se aceptaban;
  // ahora todo resultado no ASCII lanza CorreoNoAsciiError (sin el correo en el mensaje).
  it.each([
    ["e + acento combinante", "café@estudio.pe"],
    ["é compuesta", "café@estudio.pe"],
    ["E + acento combinante", "É@estudio.pe"],
    ["ß", "straße@estudio.pe"],
    ["ẞ (mayúscula)", "ẞe@estudio.pe"],
    ["İ (i con punto)", "İlse@estudio.pe"],
    ["dominio internacional sin punycode", "ana@estudiño.pe"],
  ])("fuera de ASCII (%s) lanza CorreoNoAsciiError sin el correo", (_n, correo) => {
    let error: unknown;
    try {
      normalizarCorreo(correo);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CorreoNoAsciiError);
    expect((error as Error).message).toBe("correo_no_ascii");
  });

  it("acepta un dominio internacional en punycode", () => {
    expect(normalizarCorreo(" Ana@XN--ESTUDIO-ZWA.PE ")).toBe("ana@xn--estudio-zwa.pe");
  });

  it("el signo Kelvin (U+212A) queda como 'k' ASCII", () => {
    expect(normalizarCorreo("Kelvin@estudio.pe")).toBe("kelvin@estudio.pe");
  });

  it("es idempotente", () => {
    const entradas = ["  Ana@Estudio.PE ", "K@x.pe", "plano@estudio.pe"];
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

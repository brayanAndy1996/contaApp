// Spec 023 · T18 (H-023-1-3, H-023-1-4): saneo de los datos del portal SOL antes de insertarlos.
import { describe, expect, it } from "vitest";
import { idSunatValido, sanearTextoPortal } from "./index";
import { LARGO_MAXIMO_ID_SUNAT, quitarInvisibles } from "./saneo";

describe("sanearTextoPortal", () => {
  it("quita NUL, controles y formato; saltos y tabuladores pasan a espacio; recorta extremos", () => {
    expect(sanearTextoPortal("Boletín\u0000 informativo\u0007 de mayo")).toBe(
      "Boletín informativo de mayo",
    );
    expect(sanearTextoPortal("SU\u0000NAT\u001f")).toBe("SUNAT");
    expect(sanearTextoPortal("CT\u0000-9")).toBe("CT-9");
    expect(sanearTextoPortal(" Aviso\tde\ncobranza\u200b\u202e ")).toBe(
      "Aviso de cobranza",
    );
    expect(sanearTextoPortal("Resolución coactiva")).toBe(
      "Resolución coactiva",
    );
  });

  it("un texto hecho solo de invisibles queda vacío", () => {
    expect(sanearTextoPortal("\u0000\u0001\u200b")).toBe("");
    expect(quitarInvisibles("a\u0000\ud800b")).toBe("ab");
  });
});

describe("idSunatValido", () => {
  it("acepta de 1 a 64 puntos de código", () => {
    expect(idSunatValido("A")).toBe(true);
    expect(idSunatValido("X".repeat(LARGO_MAXIMO_ID_SUNAT))).toBe(true);
    // 64 emojis: 128 unidades UTF-16 pero 64 puntos de código, como cuenta char_length.
    expect(idSunatValido("😀".repeat(64))).toBe(true);
  });

  it("rechaza vacío, más de 64 puntos de código y NUL", () => {
    expect(idSunatValido("")).toBe(false);
    expect(idSunatValido("X".repeat(65))).toBe(false);
    expect(idSunatValido("N\u0000UL")).toBe(false);
  });
});

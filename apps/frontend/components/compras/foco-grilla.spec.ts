import { describe, expect, it } from "vitest";
import { debeEnfocar } from "./foco-grilla";

// Spec 018 · T11d: la marca de foco solo la consume el efecto cuyo render tiene como activa la celda pedida.

describe("debeEnfocar", () => {
  it("feliz: enfoca con «activa» o cuando la celda activa es la pedida", () => {
    expect(debeEnfocar("activa", { r: 2, c: 5 })).toBe(true);
    expect(debeEnfocar({ r: 2, c: 6 }, { r: 2, c: 6 })).toBe(true);
  });

  it("error: el efecto de un render viejo (otra celda activa) no consume la marca ni enfoca", () => {
    // Tab desde «Base DG» (c 5) hacia «IGV DG» (c 6) con efectos pasivos del render anterior aún pendientes.
    expect(debeEnfocar({ r: 2, c: 6 }, { r: 2, c: 5 })).toBe(false);
    expect(debeEnfocar({ r: 3, c: 6 }, { r: 2, c: 6 })).toBe(false);
  });

  it("sin marca pendiente no enfoca", () => {
    expect(debeEnfocar(null, { r: 0, c: 0 })).toBe(false);
  });
});

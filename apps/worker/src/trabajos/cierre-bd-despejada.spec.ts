// Spec 009 · T7 (CA-8, D11/D18): decisión pura de qué hacer cuando la BD compartida no está despejada de trabajos
// vivos de otras suites, antes de las pruebas de cierre de 008. Sin Redis ni BD.
import { describe, expect, it, vi } from "vitest";
import {
  accionBdNoDespejada,
  exigirBdDespejada,
  MENSAJE_BD_NO_DESPEJADA,
} from "../../test/bd-despejada.js";

describe("accionBdNoDespejada", () => {
  it("con CI=true falla", () => {
    expect(accionBdNoDespejada({ CI: "true" })).toBe("fallar");
  });
  it("sin CI omite", () => {
    expect(accionBdNoDespejada({})).toBe("omitir");
  });
  it("con CI distinto de true (vacío o false) omite", () => {
    expect(accionBdNoDespejada({ CI: "" })).toBe("omitir");
    expect(accionBdNoDespejada({ CI: "false" })).toBe("omitir");
  });
});

describe("exigirBdDespejada", () => {
  const omitir = () => {
    const skip = vi.fn((): never => {
      throw new Error("omitida");
    });
    return skip;
  };

  it("BD despejada: no omite ni falla, con o sin CI", () => {
    const skip = omitir();
    expect(() =>
      exigirBdDespejada(true, { skip }, { CI: "true" }),
    ).not.toThrow();
    expect(() => exigirBdDespejada(true, { skip }, {})).not.toThrow();
    expect(skip).not.toHaveBeenCalled();
  });

  it("CI=true y BD no despejada: lanza un error que nombra la causa y no omite", () => {
    const skip = omitir();
    expect(() => exigirBdDespejada(false, { skip }, { CI: "true" })).toThrow(
      MENSAJE_BD_NO_DESPEJADA,
    );
    expect(MENSAJE_BD_NO_DESPEJADA).toMatch(/trabajos vivos/);
    expect(MENSAJE_BD_NO_DESPEJADA).toMatch(/20 s/);
    expect(skip).not.toHaveBeenCalled();
  });

  it("sin CI y BD no despejada: omite", () => {
    const skip = omitir();
    expect(() => exigirBdDespejada(false, { skip }, {})).toThrow("omitida");
    expect(skip).toHaveBeenCalledTimes(1);
  });
});

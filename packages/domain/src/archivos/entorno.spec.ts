// Spec 012b (T1, rojo): `permiteProvisional(nodeEnv)` (D2; CA-4). Única función para backend y worker:
// `nodeEnv !== "production"`. En producción el formato provisional no se genera; en cualquier otro entorno, sí.
import { describe, expect, it } from "vitest";
import { permiteProvisional } from "../index";

describe("permiteProvisional · D2", () => {
  it("production → falso", () => {
    expect(permiteProvisional("production")).toBe(false);
  });

  it.each(["development", "test", "staging", "local", ""] as const)("%j → verdadero", (entorno) => {
    expect(permiteProvisional(entorno)).toBe(true);
  });

  it("sin NODE_ENV (undefined) → verdadero", () => {
    expect(permiteProvisional(undefined)).toBe(true);
  });

  it("devuelve siempre un booleano estricto y es pura: el mismo valor da el mismo resultado", () => {
    for (const v of ["production", "test", undefined, ""] as const) {
      expect(typeof permiteProvisional(v)).toBe("boolean");
      expect(permiteProvisional(v)).toBe(permiteProvisional(v));
    }
  });
});

import { describe, expect, it } from "vitest";
import type { SesionResuelta } from "../auth/auth.service.js";
import { AccesoError } from "../acceso/errores.js";
import type { Acceso } from "../acceso/guards/decoradores.js";
import { alcanceDe, contextoDe, esUuid } from "./contexto.js";

const acceso = (alcance: Acceso["alcance"]): Acceso => ({
  usuarioId: "11111111-1111-4111-8111-111111111111",
  rol: "asistente",
  permisos: new Set(),
  alcance,
});

describe("alcanceDe", () => {
  it("global y asignado se traducen al alcance de db", () => {
    expect(alcanceDe(acceso("global"))).toEqual({ tipo: "global" });
    expect(alcanceDe(acceso("asignado"))).toEqual({
      tipo: "asignado",
      usuarioId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("sin acceso en la petición falla cerrado con permiso_denegado", () => {
    expect(() => alcanceDe(undefined)).toThrowError(AccesoError);
    try {
      alcanceDe(undefined);
    } catch (e) {
      expect((e as AccesoError).codigo).toBe("permiso_denegado");
    }
  });
});

describe("contextoDe", () => {
  it("toma estudio y usuario de la sesión", () => {
    const sesion = { tenantActivo: "t", usuarioId: "u" } as SesionResuelta;
    expect(contextoDe(sesion)).toEqual({ tenantId: "t", userId: "u" });
  });

  it("sin estudio activo da estudio_requerido", () => {
    const sesion = { tenantActivo: null, usuarioId: "u" } as SesionResuelta;
    expect(() => contextoDe(sesion)).toThrowError(AccesoError);
  });
});

describe("esUuid", () => {
  it("acepta el formato canónico y rechaza lo demás", () => {
    expect(esUuid("11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(esUuid("no-es-uuid")).toBe(false);
    expect(esUuid("0")).toBe(false);
  });
});

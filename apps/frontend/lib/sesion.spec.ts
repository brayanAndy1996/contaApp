import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { instalarFetchFalso, sesionDe } from "../pruebas/soporte";
import { obtenerSesion, reiniciarSesion } from "./sesion";

// Contrato (plan 004, Frontend): `obtenerSesion()` lee GET /api/auth/sesion y la guarda en memoria;
// `obtenerSesion(true)` la recarga; 401 → null (sin guardar); `reiniciarSesion()` vacía el caché.

const ESTUDIO = { id: "e-1", nombre: "Estudio Uno" };

describe("lib/sesion", () => {
  beforeEach(() => {
    try {
      reiniciarSesion();
    } catch {
      // stub rojo: el test siguiente falla por la razón correcta
    }
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lee GET /api/auth/sesion con credentials same-origin y devuelve usuario, estudio y csrf", async () => {
    const f = instalarFetchFalso({
      "GET /api/auth/sesion": {
        status: 200,
        cuerpo: sesionDe(ESTUDIO, "csrf-1"),
      },
    });
    const s = await obtenerSesion();
    expect(s).toEqual(sesionDe(ESTUDIO, "csrf-1"));
    expect(f.de("GET /api/auth/sesion")).toHaveLength(1);
    expect(f.llamadas[0]?.credentials).toBe("same-origin");
  });

  it("guarda la sesión en memoria: dos llamadas, una sola petición", async () => {
    const f = instalarFetchFalso({
      "GET /api/auth/sesion": { status: 200, cuerpo: sesionDe(ESTUDIO) },
    });
    await obtenerSesion();
    await obtenerSesion();
    expect(f.de("GET /api/auth/sesion")).toHaveLength(1);
  });

  it("obtenerSesion(true) recarga y devuelve los datos nuevos (csrf rotado)", async () => {
    const f = instalarFetchFalso({
      "GET /api/auth/sesion": (_l, vez) => ({
        status: 200,
        cuerpo: sesionDe(ESTUDIO, `csrf-${vez}`),
      }),
    });
    expect((await obtenerSesion())?.csrf).toBe("csrf-1");
    expect((await obtenerSesion(true))?.csrf).toBe("csrf-2");
    expect(f.de("GET /api/auth/sesion")).toHaveLength(2);
  });

  it("reiniciarSesion() vacía el caché", async () => {
    const f = instalarFetchFalso({
      "GET /api/auth/sesion": { status: 200, cuerpo: sesionDe(ESTUDIO) },
    });
    await obtenerSesion();
    reiniciarSesion();
    await obtenerSesion();
    expect(f.de("GET /api/auth/sesion")).toHaveLength(2);
  });

  it("401 → null y no guarda nada (la siguiente llamada vuelve a preguntar)", async () => {
    const f = instalarFetchFalso({
      "GET /api/auth/sesion": {
        status: 401,
        cuerpo: { codigo: "sesion_invalida" },
      },
    });
    expect(await obtenerSesion()).toBeNull();
    expect(await obtenerSesion()).toBeNull();
    expect(f.de("GET /api/auth/sesion")).toHaveLength(2);
  });
});

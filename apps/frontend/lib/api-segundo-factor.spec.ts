import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { instalarFetchFalso } from "../pruebas/soporte";
import { errorSeg, sesionSegura } from "../pruebas/seguridad";
import { api } from "./api";
import { reiniciarSesion } from "./sesion";

// Contrato (plan 029, «Exigencia: 403 segundo_factor_requerido»; CA-4). Cuando el backend responde
// 403 `{ codigo: "segundo_factor_requerido" }` a cualquier petición con sesión, `api()` lleva al usuario a
// enrolar: `window.location.assign("/cuenta/seguridad")` (como `irALogin` con el 401), salvo que ya esté en
// esa ruta. Devuelve la respuesta tal cual (`ok: false`, status 403) y no reintenta. Otros 403 (sin permiso)
// no navegan.

describe("lib/api: 403 segundo_factor_requerido (029)", () => {
  const asignar = vi.fn();
  const sesion = () => ({
    status: 200,
    cuerpo: sesionSegura({ factor: "sin_factor", factorExigido: true }),
  });

  function en(pathname: string) {
    vi.stubGlobal("location", { pathname, assign: asignar });
  }

  beforeEach(() => {
    reiniciarSesion();
    asignar.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("navega a /cuenta/seguridad, devuelve el 403 y no reintenta", async () => {
    en("/clientes");
    const f = instalarFetchFalso({
      "GET /api/auth/sesion": sesion,
      "GET /api/clientes": {
        status: 403,
        cuerpo: errorSeg("segundo_factor_requerido"),
      },
    });
    const r = await api("/clientes");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
    expect(f.de("GET /api/clientes")).toHaveLength(1);
    expect(asignar).toHaveBeenCalledTimes(1);
    expect(asignar).toHaveBeenCalledWith("/cuenta/seguridad");
  });

  it("ya en /cuenta/seguridad no navega (sin bucle)", async () => {
    en("/cuenta/seguridad");
    instalarFetchFalso({
      "GET /api/auth/sesion": sesion,
      "GET /api/auth/sesiones": {
        status: 403,
        cuerpo: errorSeg("segundo_factor_requerido"),
      },
    });
    const r = await api("/auth/sesiones");
    expect(r.status).toBe(403);
    expect(asignar).not.toHaveBeenCalled();
  });

  it("un 403 por falta de permiso no navega", async () => {
    en("/clientes");
    instalarFetchFalso({
      "GET /api/auth/sesion": sesion,
      "GET /api/clientes": { status: 403, cuerpo: { codigo: "sin_permiso" } },
    });
    const r = await api("/clientes");
    expect(r.status).toBe(403);
    expect(asignar).not.toHaveBeenCalled();
  });
});

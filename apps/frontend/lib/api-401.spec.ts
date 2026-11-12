import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { instalarFetchFalso, sesionDe } from "../pruebas/soporte";
import { api } from "./api";
import { reiniciarSesion } from "./sesion";

// Spec 018, T11a: un 401 no expulsa al login a ciegas. Al cambiar de estudio el servidor rota la
// sesión y revoca al instante el token viejo; una petición ya en vuelo con la cookie vieja recibe
// 401. `api()` comprueba la sesión real (una vez, compartida) y, si sigue vigente, reintenta UNA vez.

const ESTUDIO = { id: "e-2", nombre: "Estudio Dos" };
const NO_AUTORIZADO = { status: 401, cuerpo: { codigo: "no_autenticado" } };

describe("lib/api: 401 por la rotación de sesión", () => {
  const asignar = vi.fn();
  beforeEach(() => {
    reiniciarSesion();
    asignar.mockClear();
    vi.stubGlobal("location", { pathname: "/clientes", assign: asignar });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("401 con sesión válida: reintenta una vez con la sesión nueva y devuelve el OK", async () => {
    const f = instalarFetchFalso({
      "GET /api/auth/sesion": (_l, vez) => ({
        status: 200,
        cuerpo: sesionDe(ESTUDIO, `csrf-${vez}`),
      }),
      "POST /api/clientes": (_l, vez) =>
        vez === 1 ? NO_AUTORIZADO : { status: 201, cuerpo: { id: "c-1" } },
    });
    const r = await api("/clientes", { method: "POST", body: { ruc: "1" } });
    expect(r).toEqual({ ok: true, status: 201, datos: { id: "c-1" } });
    const posts = f.de("POST /api/clientes");
    expect(posts).toHaveLength(2);
    // El reintento usa el CSRF de la sesión recargada, no el viejo.
    expect(posts[0]?.headers["x-csrf-token"]).toBe("csrf-1");
    expect(posts[1]?.headers["x-csrf-token"]).toBe("csrf-2");
    expect(posts[1]?.headers["x-estudio"]).toBe(ESTUDIO.id);
    expect(asignar).not.toHaveBeenCalled();
  });

  it("401 con sesión inválida: va a /login sin reintentar", async () => {
    const f = instalarFetchFalso({
      "GET /api/auth/sesion": (_l, vez) =>
        vez === 1 ? { status: 200, cuerpo: sesionDe(ESTUDIO) } : NO_AUTORIZADO,
      "GET /api/clientes": NO_AUTORIZADO,
    });
    const r = await api("/clientes");
    expect(r.status).toBe(401);
    expect(f.de("GET /api/clientes")).toHaveLength(1);
    expect(asignar).toHaveBeenCalledWith("/login");
  });

  it("si el reintento también da 401: va a /login sin bucle", async () => {
    const f = instalarFetchFalso({
      "GET /api/auth/sesion": { status: 200, cuerpo: sesionDe(ESTUDIO) },
      "GET /api/clientes": NO_AUTORIZADO,
    });
    const r = await api("/clientes");
    expect(r.status).toBe(401);
    expect(f.de("GET /api/clientes")).toHaveLength(2);
    expect(f.de("GET /api/auth/sesion")).toHaveLength(2);
    expect(asignar).toHaveBeenCalledWith("/login");
  });

  it("dos 401 simultáneos comparten una sola comprobación de sesión", async () => {
    const f = instalarFetchFalso({
      "GET /api/auth/sesion": { status: 200, cuerpo: sesionDe(ESTUDIO) },
      "GET /api/clientes": (_l, vez) =>
        vez === 1 ? NO_AUTORIZADO : { status: 200, cuerpo: [] },
      "GET /api/notificaciones/no-leidas": (_l, vez) =>
        vez === 1 ? NO_AUTORIZADO : { status: 200, cuerpo: { total: 0 } },
    });
    const [a, b] = await Promise.all([
      api("/clientes"),
      api("/notificaciones/no-leidas"),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    // 1 lectura inicial (compartida) + 1 comprobación compartida por ambos 401.
    expect(f.de("GET /api/auth/sesion")).toHaveLength(2);
    expect(asignar).not.toHaveBeenCalled();
  });
});

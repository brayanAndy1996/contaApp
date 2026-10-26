import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EVENTO_ESTUDIO_DESFASADO,
  instalarFetchFalso,
  sesionDe,
} from "../pruebas/soporte";
import { api } from "./api";
import { reiniciarSesion } from "./sesion";

// Contrato (plan 004, Frontend; CA-12): `api(ruta, { method, body, sinSesion })` llama
// `fetch('/api' + ruta, { credentials: 'same-origin' })` y devuelve `{ ok, status, datos }`
// (`datos` = JSON o null si no hay cuerpo). Añade `X-CSRF-Token` en no-GET y `X-Estudio` cuando hay
// estudio activo (ambos de GET /api/auth/sesion). `sinSesion: true` (login, recuperación) no
// consulta la sesión ni añade ninguna de las dos cabeceras. 409 → recarga la sesión, emite
// `contapp:estudio-desfasado` en `window` y devuelve el 409. 403 `csrf_invalido` → recarga la
// sesión y reintenta UNA vez.

const ESTUDIO = { id: "e-1", nombre: "Estudio Uno" };

describe("lib/api", () => {
  beforeEach(() => {
    try {
      reiniciarSesion();
    } catch {
      // stub rojo
    }
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GET: antepone /api, usa credentials same-origin y envía X-Estudio con el estudio activo", async () => {
    const f = instalarFetchFalso({
      "GET /api/auth/sesion": { status: 200, cuerpo: sesionDe(ESTUDIO) },
      "GET /api/estudio/actual": { status: 200, cuerpo: ESTUDIO },
    });
    const r = await api("/estudio/actual");
    expect(r).toEqual({ ok: true, status: 200, datos: ESTUDIO });
    const [llamada] = f.de("GET /api/estudio/actual");
    expect(llamada?.url).toBe("/api/estudio/actual");
    expect(llamada?.credentials).toBe("same-origin");
    expect(llamada?.headers["x-estudio"]).toBe(ESTUDIO.id);
  });

  it("GET sin estudio activo: no envía X-Estudio", async () => {
    const f = instalarFetchFalso({
      "GET /api/auth/sesion": { status: 200, cuerpo: sesionDe(null) },
      "GET /api/auth/estudios": { status: 200, cuerpo: [] },
    });
    await api("/auth/estudios");
    expect(
      f.de("GET /api/auth/estudios")[0]?.headers["x-estudio"],
    ).toBeUndefined();
  });

  it("no-GET: envía X-CSRF-Token de la sesión, X-Estudio y el cuerpo como JSON", async () => {
    const f = instalarFetchFalso({
      "GET /api/auth/sesion": {
        status: 200,
        cuerpo: sesionDe(ESTUDIO, "csrf-1"),
      },
      "POST /api/auth/estudio": {
        status: 200,
        cuerpo: { estudioActivo: ESTUDIO },
      },
    });
    const r = await api("/auth/estudio", {
      method: "POST",
      body: { tenantId: "e-2" },
    });
    expect(r.status).toBe(200);
    const [llamada] = f.de("POST /api/auth/estudio");
    expect(llamada?.headers["x-csrf-token"]).toBe("csrf-1");
    expect(llamada?.headers["x-estudio"]).toBe(ESTUDIO.id);
    expect(llamada?.headers["content-type"]).toContain("application/json");
    expect(llamada?.body).toEqual({ tenantId: "e-2" });
    expect(llamada?.credentials).toBe("same-origin");
  });

  it("GET no envía X-CSRF-Token (solo los no-GET)", async () => {
    const f = instalarFetchFalso({
      "GET /api/auth/sesion": {
        status: 200,
        cuerpo: sesionDe(ESTUDIO, "csrf-1"),
      },
      "GET /api/estudio/actual": { status: 200, cuerpo: ESTUDIO },
    });
    await api("/estudio/actual");
    expect(
      f.de("GET /api/estudio/actual")[0]?.headers["x-csrf-token"],
    ).toBeUndefined();
  });

  it("sinSesion: no consulta la sesión y no envía X-CSRF-Token ni X-Estudio", async () => {
    const f = instalarFetchFalso({
      "POST /api/auth/login": {
        status: 200,
        cuerpo: { estudioActivo: null, requiereEstudio: true },
      },
    });
    const r = await api("/auth/login", {
      method: "POST",
      body: { correo: "a@ejemplo.test", contrasena: "canario-contrasena-123" },
      sinSesion: true,
    });
    expect(r.status).toBe(200);
    expect(f.llamadas).toHaveLength(1);
    expect(f.llamadas[0]?.headers["x-csrf-token"]).toBeUndefined();
    expect(f.llamadas[0]?.headers["x-estudio"]).toBeUndefined();
  });

  it("204 sin cuerpo → ok true y datos null", async () => {
    instalarFetchFalso({
      "GET /api/auth/sesion": { status: 200, cuerpo: sesionDe(ESTUDIO) },
      "POST /api/auth/logout": { status: 204 },
    });
    expect(await api("/auth/logout", { method: "POST" })).toEqual({
      ok: true,
      status: 204,
      datos: null,
    });
  });

  it("409 estudio_desfasado: recarga la sesión, avisa con el evento y devuelve el 409", async () => {
    const f = instalarFetchFalso({
      "GET /api/auth/sesion": (_l, vez) => ({
        status: 200,
        cuerpo: sesionDe(
          vez === 1 ? ESTUDIO : { id: "e-2", nombre: "Estudio Dos" },
        ),
      }),
      "GET /api/estudio/actual": {
        status: 409,
        cuerpo: { codigo: "estudio_desfasado" },
      },
    });
    const avisos: Event[] = [];
    const oyente = (e: Event) => avisos.push(e);
    window.addEventListener(EVENTO_ESTUDIO_DESFASADO, oyente);
    try {
      const r = await api("/estudio/actual");
      expect(r.status).toBe(409);
      expect(r.ok).toBe(false);
      expect(f.de("GET /api/auth/sesion")).toHaveLength(2);
      expect(f.de("GET /api/estudio/actual")).toHaveLength(1);
      expect(avisos).toHaveLength(1);
    } finally {
      window.removeEventListener(EVENTO_ESTUDIO_DESFASADO, oyente);
    }
  });

  it("403 csrf_invalido: recarga la sesión y reintenta una vez con el token nuevo", async () => {
    const f = instalarFetchFalso({
      "GET /api/auth/sesion": (_l, vez) => ({
        status: 200,
        cuerpo: sesionDe(ESTUDIO, `csrf-${vez}`),
      }),
      "POST /api/auth/estudio": (_l, vez) =>
        vez === 1
          ? { status: 403, cuerpo: { codigo: "csrf_invalido" } }
          : { status: 200, cuerpo: { estudioActivo: ESTUDIO } },
    });
    const r = await api("/auth/estudio", {
      method: "POST",
      body: { tenantId: "e-1" },
    });
    expect(r.status).toBe(200);
    const posts = f.de("POST /api/auth/estudio");
    expect(posts).toHaveLength(2);
    expect(posts[0]?.headers["x-csrf-token"]).toBe("csrf-1");
    expect(posts[1]?.headers["x-csrf-token"]).toBe("csrf-2");
    expect(posts[1]?.body).toEqual({ tenantId: "e-1" });
    expect(f.de("GET /api/auth/sesion")).toHaveLength(2);
  });

  it("403 csrf_invalido dos veces: devuelve el 403 tras exactamente un reintento (sin bucle)", async () => {
    const f = instalarFetchFalso({
      "GET /api/auth/sesion": (_l, vez) => ({
        status: 200,
        cuerpo: sesionDe(ESTUDIO, `csrf-${vez}`),
      }),
      "POST /api/auth/estudio": {
        status: 403,
        cuerpo: { codigo: "csrf_invalido" },
      },
    });
    const r = await api("/auth/estudio", {
      method: "POST",
      body: { tenantId: "e-1" },
    });
    expect(r.status).toBe(403);
    expect(f.de("POST /api/auth/estudio")).toHaveLength(2);
  });

  it("403 con otro código (origen_invalido) no reintenta", async () => {
    const f = instalarFetchFalso({
      "GET /api/auth/sesion": { status: 200, cuerpo: sesionDe(ESTUDIO) },
      "POST /api/auth/estudio": {
        status: 403,
        cuerpo: { codigo: "origen_invalido" },
      },
    });
    const r = await api("/auth/estudio", {
      method: "POST",
      body: { tenantId: "e-1" },
    });
    expect(r.status).toBe(403);
    expect(f.de("POST /api/auth/estudio")).toHaveLength(1);
    expect(f.de("GET /api/auth/sesion")).toHaveLength(1);
  });
});

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import { asentar } from "../../pruebas/acceso";
import {
  crearRouterFalso,
  instalarFetchFalso,
  sesionDe,
  type Manejador,
} from "../../pruebas/soporte";

const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  prefetch: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/estudios",
  useSearchParams: () => new URLSearchParams(),
}));

import Estudios from "./page";

// Contrato (plan 006, HTTP; D5, CA-10). El menú de plataforma vive en /estudios (donde cae quien no
// tiene estudio activo, como el super-admin): además de GET /api/auth/estudios pide
// GET /api/plataforma/yo. Con 200 { admin: true } muestra el enlace "Administración de plataforma"
// (href /admin); con 403 (o cualquier fallo) no muestra el enlace ni alertas. Ocultar es comodidad:
// el backend revalida en cada ruta de plataforma.

function rutas(yo: Manejador): Record<string, Manejador> {
  return {
    "GET /api/auth/sesion": { status: 200, cuerpo: sesionDe(null, "csrf-1") },
    "GET /api/auth/estudios": { status: 200, cuerpo: [] },
    "GET /api/plataforma/yo": yo,
  };
}

describe("/estudios · menú de plataforma (006)", () => {
  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    reiniciarSesion();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("super-admin (200): muestra 'Administración de plataforma' hacia /admin", async () => {
    instalarFetchFalso(rutas({ status: 200, cuerpo: { admin: true } }));
    render(<Estudios />);
    const enlace = await screen.findByRole("link", {
      name: "Administración de plataforma",
    });
    expect(enlace.getAttribute("href")).toBe("/admin");
  });

  it("no admin (403): no muestra el enlace ni alertas", async () => {
    const f = instalarFetchFalso(
      rutas({ status: 403, cuerpo: { codigo: "permiso_denegado" } }),
    );
    render(<Estudios />);
    await vi.waitFor(() =>
      expect(f.de("GET /api/plataforma/yo")).toHaveLength(1),
    );
    await asentar();
    expect(
      screen.queryByRole("link", { name: "Administración de plataforma" }),
    ).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

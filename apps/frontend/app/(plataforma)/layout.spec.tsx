import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import {
  crearRouterFalso,
  destinos,
  instalarFetchFalso,
  type Manejador,
} from "../../pruebas/soporte";
import {
  MENSAJES_SEG,
  sesionSegura,
  type OpcionesSesion,
} from "../../pruebas/seguridad";

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
  usePathname: () => "/admin",
  useSearchParams: () => new URLSearchParams(),
}));

import LayoutPlataforma from "./layout";

// Contrato (plan 029, Archivos: `(plataforma)/`; CA-4 «403 en toda ruta @SoloPlataforma»). Hoy `(plataforma)`
// no tiene layout; T9 crea `app/(plataforma)/layout.tsx` (default export, recibe `children`) que lee
// `GET /api/auth/sesion` y, con el rol de plataforma sin factor verificado (`factorExigido` y
// `factor !== "verificado"`), hace `router.replace("/cuenta/seguridad")` sin pintar `children` y muestra
// MENSAJES_SEG.exigidoAviso. Sin sesión (401) → `router.replace("/login")`. Con el factor verificado, o sin
// `factorExigido`, pinta `children` y no navega.

function rutas(sesion: Manejador): Record<string, Manejador> {
  return { "GET /api/auth/sesion": sesion };
}
const sesion = (o: OpcionesSesion): Manejador => ({
  status: 200,
  cuerpo: sesionSegura({ estudio: null, ...o }),
});

function pintar() {
  return render(
    <LayoutPlataforma>
      <p>panel de plataforma</p>
    </LayoutPlataforma>,
  );
}

describe("(plataforma)/layout · enrolamiento forzado (029)", () => {
  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    reiniciarSesion();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("administrador de plataforma sin factor verificado → va a /cuenta/seguridad y no pinta el panel", async () => {
    instalarFetchFalso(
      rutas(
        sesion({
          factorExigido: true,
          factor: "sin_factor",
          totpActivo: false,
        }),
      ),
    );
    pintar();
    await vi.waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith("/cuenta/seguridad"),
    );
    expect(await screen.findByText(MENSAJES_SEG.exigidoAviso)).toBeTruthy();
    expect(screen.queryByText("panel de plataforma")).toBeNull();
  });

  it("con TOTP activo pero sesión sin verificar (previa al despliegue) también va a /cuenta/seguridad", async () => {
    instalarFetchFalso(
      rutas(
        sesion({ factorExigido: true, factor: "sin_factor", totpActivo: true }),
      ),
    );
    pintar();
    await vi.waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith("/cuenta/seguridad"),
    );
    expect(screen.queryByText("panel de plataforma")).toBeNull();
  });

  it("con el factor verificado pinta el panel y no navega", async () => {
    instalarFetchFalso(
      rutas(
        sesion({ factorExigido: true, factor: "verificado", totpActivo: true }),
      ),
    );
    pintar();
    expect(await screen.findByText("panel de plataforma")).toBeTruthy();
    expect(destinos(router)).toEqual([]);
  });

  it("sin factorExigido pinta el panel y no navega", async () => {
    instalarFetchFalso(rutas(sesion({ factorExigido: false })));
    pintar();
    expect(await screen.findByText("panel de plataforma")).toBeTruthy();
    expect(destinos(router)).toEqual([]);
  });

  it("sin sesión (401) → va a /login y no pinta el panel", async () => {
    instalarFetchFalso(
      rutas({ status: 401, cuerpo: { codigo: "no_autenticado" } }),
    );
    pintar();
    await vi.waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith("/login"),
    );
    expect(screen.queryByText("panel de plataforma")).toBeNull();
  });
});

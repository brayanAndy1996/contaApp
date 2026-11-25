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
const ruta = vi.hoisted(() => ({ actual: "/" }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => ruta.actual,
  useSearchParams: () => new URLSearchParams(),
}));

import LayoutApp from "./layout";

// Contrato (plan 029, Alcance «Exigencia» y «Frontend: enrolamiento forzado»; CA-4). El layout de (app) lee
// `GET /api/auth/sesion` con los campos nuevos `factor` (pendiente|verificado|sin_factor), `totpActivo` y
// `factorExigido`. Si `factorExigido` y `factor !== "verificado"` el usuario solo puede enrolar: el layout
//   - va a `/cuenta/seguridad` con `router.replace` (salvo que ya esté en esa ruta: sin bucle),
//   - no pinta `children` mientras esté bloqueado en otra ruta (así no se lanzan peticiones que darían 403),
//     y muestra MENSAJES_SEG.exigidoAviso,
//   - en `/cuenta/seguridad` sí pinta `children` (la pantalla de enrolamiento).
// Sin `factorExigido`, o con el factor verificado, nada cambia (las sesiones sin esos campos tampoco: 004/005).

const A = { id: "e-a", nombre: "Estudio Alfa" };

function rutas(sesion: OpcionesSesion): Record<string, Manejador> {
  return {
    "GET /api/auth/sesion": {
      status: 200,
      cuerpo: sesionSegura({ estudio: A, ...sesion }),
    },
    "GET /api/auth/estudios": {
      status: 200,
      cuerpo: [{ ...A, ultimoUsado: true }],
    },
  };
}

function pintar() {
  return render(
    <LayoutApp>
      <p>contenido de la página</p>
    </LayoutApp>,
  );
}

describe("(app)/layout · enrolamiento forzado (029)", () => {
  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    ruta.actual = "/";
    reiniciarSesion();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("factorExigido sin factor verificado → router.replace('/cuenta/seguridad'), con aviso y sin pintar la página", async () => {
    instalarFetchFalso(
      rutas({ factorExigido: true, factor: "sin_factor", totpActivo: false }),
    );
    pintar();
    await vi.waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith("/cuenta/seguridad"),
    );
    expect(await screen.findByText(MENSAJES_SEG.exigidoAviso)).toBeTruthy();
    expect(screen.queryByText("contenido de la página")).toBeNull();
    expect(destinos(router)).not.toContain("/estudios");
  });

  it("ya en /cuenta/seguridad no vuelve a redirigir y sí pinta la pantalla", async () => {
    ruta.actual = "/cuenta/seguridad";
    instalarFetchFalso(
      rutas({ factorExigido: true, factor: "sin_factor", totpActivo: false }),
    );
    pintar();
    expect(await screen.findByLabelText("Estudio")).toBeTruthy();
    expect(screen.getByText("contenido de la página")).toBeTruthy();
    expect(destinos(router)).not.toContain("/cuenta/seguridad");
  });

  it("factorExigido con el factor verificado → sin redirección y con la página", async () => {
    instalarFetchFalso(
      rutas({ factorExigido: true, factor: "verificado", totpActivo: true }),
    );
    pintar();
    expect(await screen.findByLabelText("Estudio")).toBeTruthy();
    expect(screen.getByText("contenido de la página")).toBeTruthy();
    expect(screen.queryByText(MENSAJES_SEG.exigidoAviso)).toBeNull();
    expect(destinos(router)).toEqual([]);
  });

  it("sin factorExigido (aunque no haya TOTP) → sin redirección y con la página", async () => {
    instalarFetchFalso(
      rutas({ factorExigido: false, factor: "sin_factor", totpActivo: false }),
    );
    pintar();
    expect(await screen.findByLabelText("Estudio")).toBeTruthy();
    expect(screen.getByText("contenido de la página")).toBeTruthy();
    expect(destinos(router)).toEqual([]);
  });

  it("una sesión sin los campos de 029 (backend anterior) se comporta como antes", async () => {
    instalarFetchFalso({
      "GET /api/auth/sesion": {
        status: 200,
        cuerpo: {
          usuario: {
            id: "u-1",
            nombre: "Ana Prueba",
            correo: "ana@ejemplo.test",
          },
          estudioActivo: A,
          csrf: "csrf-1",
        },
      },
      "GET /api/auth/estudios": {
        status: 200,
        cuerpo: [{ ...A, ultimoUsado: true }],
      },
    });
    pintar();
    expect(await screen.findByLabelText("Estudio")).toBeTruthy();
    expect(screen.getByText("contenido de la página")).toBeTruthy();
    expect(destinos(router)).toEqual([]);
  });
});

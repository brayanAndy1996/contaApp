import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
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
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import LayoutApp from "./layout";

// Contrato (plan 004, Frontend; CA-12). Layout de las pantallas autenticadas: carga la sesión
// (GET /api/auth/sesion) y los estudios (GET /api/auth/estudios) y muestra, junto a `children`, un
// menú con un <select> de etiqueta "Estudio" (una <option value={id}> por estudio; el valor es el
// estudio activo). Al cambiar: POST /api/auth/estudio { tenantId } con X-CSRF-Token, recarga la
// sesión (la cookie y el csrf rotaron) y pide a Next refrescar los datos (router.refresh()).

const A = { id: "e-a", nombre: "Estudio Alfa" };
const B = { id: "e-b", nombre: "Estudio Beta" };

function rutas(): Record<string, Manejador> {
  return {
    "GET /api/auth/sesion": (_l, vez) => ({
      status: 200,
      cuerpo: sesionDe(vez === 1 ? A : B, `csrf-${vez}`),
    }),
    "GET /api/auth/estudios": {
      status: 200,
      cuerpo: [
        { ...A, ultimoUsado: true },
        { ...B, ultimoUsado: false },
      ],
    },
    "POST /api/auth/estudio": {
      status: 200,
      cuerpo: { estudioActivo: B },
    },
  };
}

describe("(app)/layout · menú de estudio", () => {
  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    try {
      reiniciarSesion();
    } catch {
      // stub rojo
    }
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("muestra el contenido y el selector con los estudios y el activo seleccionado", async () => {
    instalarFetchFalso(rutas());
    render(
      <LayoutApp>
        <p>contenido de la página</p>
      </LayoutApp>,
    );
    const selector = (await screen.findByLabelText(
      "Estudio",
    )) as HTMLSelectElement;
    expect(screen.getByText("contenido de la página")).toBeTruthy();
    const opciones = [...selector.options].map((o) => [o.value, o.text]);
    expect(opciones).toEqual([
      [A.id, A.nombre],
      [B.id, B.nombre],
    ]);
    await vi.waitFor(() => expect(selector.value).toBe(A.id));
  });

  it("al cambiar de estudio hace POST con tenantId y X-CSRF-Token", async () => {
    const f = instalarFetchFalso(rutas());
    render(
      <LayoutApp>
        <p>contenido</p>
      </LayoutApp>,
    );
    const selector = await screen.findByLabelText("Estudio");
    const user = userEvent.setup();
    await user.selectOptions(selector, B.id);
    await vi.waitFor(() =>
      expect(f.de("POST /api/auth/estudio")).toHaveLength(1),
    );
    const [llamada] = f.de("POST /api/auth/estudio");
    expect(llamada?.body).toEqual({ tenantId: B.id });
    expect(llamada?.headers["x-csrf-token"]).toBe("csrf-1");
  });

  it("tras el POST recarga la sesión (csrf rotado), muestra el estudio nuevo y refresca los datos", async () => {
    const f = instalarFetchFalso(rutas());
    render(
      <LayoutApp>
        <p>contenido</p>
      </LayoutApp>,
    );
    const selector = (await screen.findByLabelText(
      "Estudio",
    )) as HTMLSelectElement;
    const user = userEvent.setup();
    await user.selectOptions(selector, B.id);
    await vi.waitFor(() => expect(router.refresh).toHaveBeenCalled());
    const orden = f.llamadas.map((l) => `${l.method} ${l.ruta}`);
    const iPost = orden.indexOf("POST /api/auth/estudio");
    expect(iPost).toBeGreaterThan(-1);
    expect(orden.slice(iPost + 1)).toContain("GET /api/auth/sesion");
    await vi.waitFor(() =>
      expect(
        (screen.getByLabelText("Estudio") as HTMLSelectElement).value,
      ).toBe(B.id),
    );
  });

  it("si el POST falla (403 estudio_no_disponible) no refresca los datos", async () => {
    instalarFetchFalso({
      ...rutas(),
      "POST /api/auth/estudio": {
        status: 403,
        cuerpo: { codigo: "estudio_no_disponible" },
      },
    });
    render(
      <LayoutApp>
        <p>contenido</p>
      </LayoutApp>,
    );
    const selector = await screen.findByLabelText("Estudio");
    const user = userEvent.setup();
    await user.selectOptions(selector, B.id);
    await vi.waitFor(() =>
      expect(screen.getByRole("alert").textContent?.length).toBeGreaterThan(0),
    );
    expect(router.refresh).not.toHaveBeenCalled();
  });
});

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import {
  MENSAJES,
  crearRouterFalso,
  destinos,
  instalarFetchFalso,
  sesionDe,
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

// Contrato (plan 004, Frontend; CA-12, P7). Pantalla /estudios: carga GET /api/auth/estudios
// ([{id, nombre, ultimoUsado}]); cada estudio es un botón con su nombre; el último usado lleva
// aria-current="true" (los demás no). Al elegir: POST /api/auth/estudio { tenantId } (con
// X-CSRF-Token de la sesión) y luego va a "/". Lista vacía → texto "No perteneces a ningún estudio
// activo" y ningún botón de estudio.

const A = { id: "e-a", nombre: "Estudio Alfa" };
const B = { id: "e-b", nombre: "Estudio Beta" };

describe("/estudios", () => {
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

  it("lista los estudios del usuario y resalta el último usado", async () => {
    instalarFetchFalso({
      "GET /api/auth/sesion": { status: 200, cuerpo: sesionDe(null) },
      "GET /api/auth/estudios": {
        status: 200,
        cuerpo: [
          { ...A, ultimoUsado: false },
          { ...B, ultimoUsado: true },
        ],
      },
    });
    render(<Estudios />);
    const beta = await screen.findByRole("button", { name: /Estudio Beta/ });
    const alfa = screen.getByRole("button", { name: /Estudio Alfa/ });
    expect(beta.getAttribute("aria-current")).toBe("true");
    expect(alfa.getAttribute("aria-current")).not.toBe("true");
  });

  it("sin ningún estudio activo muestra el aviso de P7 y ningún botón de estudio", async () => {
    instalarFetchFalso({
      "GET /api/auth/sesion": { status: 200, cuerpo: sesionDe(null) },
      "GET /api/auth/estudios": { status: 200, cuerpo: [] },
    });
    render(<Estudios />);
    expect(
      await screen.findByText(new RegExp(MENSAJES.sinEstudios)),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Estudio/ })).toBeNull();
  });

  it("con estudios no muestra el aviso de 'sin estudios'", async () => {
    instalarFetchFalso({
      "GET /api/auth/sesion": { status: 200, cuerpo: sesionDe(null) },
      "GET /api/auth/estudios": {
        status: 200,
        cuerpo: [
          { ...A, ultimoUsado: true },
          { ...B, ultimoUsado: false },
        ],
      },
    });
    render(<Estudios />);
    await screen.findByRole("button", { name: /Estudio Alfa/ });
    expect(screen.queryByText(new RegExp(MENSAJES.sinEstudios))).toBeNull();
  });

  it("al elegir uno hace POST /api/auth/estudio con tenantId y X-CSRF-Token, y entra a /", async () => {
    const f = instalarFetchFalso({
      "GET /api/auth/sesion": { status: 200, cuerpo: sesionDe(null, "csrf-1") },
      "GET /api/auth/estudios": {
        status: 200,
        cuerpo: [
          { ...A, ultimoUsado: true },
          { ...B, ultimoUsado: false },
        ],
      },
      "POST /api/auth/estudio": { status: 200, cuerpo: { estudioActivo: B } },
    });
    render(<Estudios />);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: /Estudio Beta/ }),
    );
    await vi.waitFor(() =>
      expect(f.de("POST /api/auth/estudio")).toHaveLength(1),
    );
    const [llamada] = f.de("POST /api/auth/estudio");
    expect(llamada?.body).toEqual({ tenantId: B.id });
    expect(llamada?.headers["x-csrf-token"]).toBe("csrf-1");
    await vi.waitFor(() => expect(destinos(router)).toEqual(["/"]));
  });

  it("si el POST falla (403 estudio_no_disponible) no navega", async () => {
    instalarFetchFalso({
      "GET /api/auth/sesion": { status: 200, cuerpo: sesionDe(null) },
      "GET /api/auth/estudios": {
        status: 200,
        cuerpo: [
          { ...A, ultimoUsado: true },
          { ...B, ultimoUsado: false },
        ],
      },
      "POST /api/auth/estudio": {
        status: 403,
        cuerpo: { codigo: "estudio_no_disponible" },
      },
    });
    render(<Estudios />);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: /Estudio Beta/ }),
    );
    await vi.waitFor(() =>
      expect(screen.getByRole("alert").textContent?.length).toBeGreaterThan(0),
    );
    expect(destinos(router)).toEqual([]);
  });
});

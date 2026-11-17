import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import {
  crearRouterFalso,
  instalarFetchFalso,
  sesionDe,
} from "../../pruebas/soporte";
import { Campana } from "./campana";

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

// Spec 038 T-final-b/h: desde 1024 px la campana vive en el menú lateral (256 px, con desplazamiento propio) y su panel
// se fija junto al menú, hacia la derecha, para quedar entero dentro de la ventana. jsdom no aplica CSS: se comprueban
// las clases del mismo elemento.

beforeEach(() => {
  Object.assign(router, crearRouterFalso());
  reiniciarSesion();
  instalarFetchFalso({
    "GET /api/auth/sesion": {
      status: 200,
      cuerpo: sesionDe({ id: "e-a", nombre: "Estudio Alfa" }),
    },
    "GET /api/notificaciones/no-leidas": {
      status: 200,
      cuerpo: { noLeidas: 0 },
    },
    "GET /api/notificaciones": {
      status: 200,
      cuerpo: { items: [], siguiente: null },
    },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Campana · menú lateral (escritorio)", () => {
  it("el panel se ancla a la derecha del menú (fijo, sin right-0) y se queda dentro de la ventana", async () => {
    const user = userEvent.setup();
    render(<Campana />);
    await user.click(
      await screen.findByRole("button", { name: /Notificaciones/ }),
    );
    const panel = await screen.findByRole("dialog", {
      name: "Panel de notificaciones",
    });
    const clases = panel.className.split(/\s+/);
    for (const c of [
      "lg:fixed",
      "lg:left-[17rem]",
      "lg:right-auto",
      "lg:bottom-4",
      "lg:max-h-[calc(100dvh-2rem)]",
      "lg:overflow-y-auto",
    ]) {
      expect(clases).toContain(c);
    }
  });

  it("el botón usa el mismo estilo que las demás entradas del menú, con su nombre accesible intacto", async () => {
    render(<Campana />);
    const boton = await screen.findByRole("button", { name: "Notificaciones" });
    for (const c of [
      "min-h-11",
      "rounded-control",
      "font-semibold",
      "hover:bg-neutro-fondo",
      "focus-visible:outline-primario",
    ]) {
      expect(boton.classList.contains(c)).toBe(true);
    }
  });
});

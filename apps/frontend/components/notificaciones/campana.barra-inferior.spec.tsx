import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import { crearRouterFalso, instalarFetchFalso, sesionDe } from "../../pruebas/soporte";
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

// Spec 038 T18 (4): en la barra inferior de celular la campana no se empuja a la derecha y su panel se abre hacia
// arriba sin salirse de la pantalla. jsdom no aplica CSS: se comprueban las clases del mismo elemento.

beforeEach(() => {
  Object.assign(router, crearRouterFalso());
  reiniciarSesion();
  instalarFetchFalso({
    "GET /api/auth/sesion": { status: 200, cuerpo: sesionDe({ id: "e-a", nombre: "Estudio Alfa" }) },
    "GET /api/notificaciones/no-leidas": { status: 200, cuerpo: { noLeidas: 0 } },
    "GET /api/notificaciones": { status: 200, cuerpo: { items: [], siguiente: null } },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Campana · barra inferior (celular)", () => {
  it("el contenedor solo se alinea a la derecha desde 1024 px (sin ml-auto en celular)", async () => {
    render(<Campana />);
    const boton = await screen.findByRole("button", { name: /Notificaciones/ });
    const contenedor = boton.parentElement as HTMLElement;
    expect(contenedor.classList.contains("ml-auto")).toBe(false);
    expect(contenedor.classList.contains("lg:ml-auto")).toBe(true);
  });

  it("el panel se abre hacia arriba bajo 1024 px, con altura acotada y por encima de la barra en pantallas muy angostas", async () => {
    const user = userEvent.setup();
    render(<Campana />);
    await user.click(await screen.findByRole("button", { name: /Notificaciones/ }));
    const panel = await screen.findByRole("dialog", { name: "Panel de notificaciones" });
    const clases = panel.className;
    expect(clases).toContain("max-lg:bottom-full");
    expect(clases).toContain("max-lg:mt-0");
    expect(clases).toContain("max-lg:overflow-y-auto");
    expect(clases).toContain("max-lg:max-h-[");
    expect(clases).toContain("max-sm:bottom-[calc(var(--alto-barra-inferior,4.5rem)+0.5rem)]");
    // Escritorio sin cambios: sigue colgando hacia abajo desde la campana.
    expect(clases).toContain("absolute right-0");
    expect(clases).toContain("mt-2");
  });
});

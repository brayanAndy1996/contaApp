import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Yo } from "../../lib/acceso";

vi.mock("next/navigation", () => ({ usePathname: () => "/clientes" }));

import { MenuPrincipal, VARIABLE_ALTO_BARRA } from "./menu-principal";

// Spec 038 T18 (2): el menú publica el alto real de la barra inferior para el botón fijo «Generar archivo».

const YO = { permisos: ["clientes.ver"] } as unknown as Yo;

function pintar() {
  return render(
    <MenuPrincipal
      estudioActivoId="e-a"
      estudios={[{ id: "e-a", nombre: "Estudio Alfa" }]}
      yo={YO}
      campana={<button type="button">Notificaciones</button>}
      alCambiarEstudio={() => {}}
      alCerrarSesion={() => {}}
    />,
  );
}

const alto = () => document.documentElement.style.getPropertyValue(VARIABLE_ALTO_BARRA);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("MenuPrincipal · --alto-barra-inferior", () => {
  it("feliz: define la variable con el alto medido de la barra y la quita al desmontarse", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      height: 56.4,
    } as DOMRect);
    const { unmount } = pintar();
    expect(VARIABLE_ALTO_BARRA).toBe("--alto-barra-inferior");
    expect(alto()).toBe("57px");
    unmount();
    expect(alto()).toBe("");
  });

  it("con el menú lateral (desde 1024 px) la variable vale 0", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      height: 800,
    } as DOMRect);
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("1024px") }));
    pintar();
    expect(screen.getByRole("navigation")).toBeTruthy();
    expect(alto()).toBe("0px");
  });
});

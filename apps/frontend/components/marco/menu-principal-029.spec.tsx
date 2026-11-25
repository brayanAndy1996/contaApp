import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Yo } from "../../lib/acceso";

const ruta = vi.hoisted(() => ({ actual: "/clientes" }));
vi.mock("next/navigation", () => ({ usePathname: () => ruta.actual }));

import { MenuPrincipal } from "./menu-principal";

// Spec 029 · T4 (rojo). Entrada «Seguridad» del menú principal: un enlace «Seguridad» a `/cuenta/seguridad`,
// UNA vez en el DOM, visible para cualquier miembro (es de la cuenta, no de un permiso: igual que
// «Cambiar contraseña»), con `aria-current="page"` en esa ruta y sin él en las demás.

const yo = (...permisos: string[]) => ({ permisos }) as unknown as Yo;

function pintar(permisos: string[] = ["clientes.ver"]) {
  return render(
    <MenuPrincipal
      estudioActivoId="e-a"
      estudios={[{ id: "e-a", nombre: "Estudio Alfa" }]}
      yo={yo(...permisos)}
      campana={<button type="button">Notificaciones</button>}
      alCambiarEstudio={() => {}}
      alCerrarSesion={() => {}}
    />,
  );
}

beforeEach(() => {
  ruta.actual = "/clientes";
});
afterEach(() => cleanup());

describe("MenuPrincipal · «Seguridad» (029)", () => {
  it("enlace «Seguridad» a /cuenta/seguridad, una sola vez", () => {
    pintar();
    const enlaces = screen.getAllByRole("link", { name: "Seguridad" });
    expect(enlaces).toHaveLength(1);
    expect(enlaces[0]!.getAttribute("href")).toBe("/cuenta/seguridad");
  });

  it("aparece aunque el usuario no tenga permisos de negocio (lectura mínima)", () => {
    pintar([]);
    expect(screen.getByRole("link", { name: "Seguridad" })).toBeTruthy();
  });

  it("también sin la carga de permisos (yo = null)", () => {
    render(
      <MenuPrincipal
        estudioActivoId="e-a"
        estudios={[{ id: "e-a", nombre: "Estudio Alfa" }]}
        yo={null}
        campana={null}
        alCambiarEstudio={() => {}}
        alCerrarSesion={() => {}}
      />,
    );
    expect(screen.getByRole("link", { name: "Seguridad" })).toBeTruthy();
  });

  it("en /cuenta/seguridad es la entrada activa (aria-current=page) y «Cambiar contraseña» no", () => {
    ruta.actual = "/cuenta/seguridad";
    pintar();
    expect(
      screen
        .getByRole("link", { name: "Seguridad" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      screen
        .getByRole("link", { name: "Cambiar contraseña" })
        .getAttribute("aria-current"),
    ).toBeNull();
  });

  it("en otras rutas no está marcada como actual", () => {
    pintar();
    expect(
      screen
        .getByRole("link", { name: "Seguridad" })
        .getAttribute("aria-current"),
    ).toBeNull();
  });
});

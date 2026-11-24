import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Yo } from "../../lib/acceso";

const ruta = vi.hoisted(() => ({ actual: "/clientes" }));
vi.mock("next/navigation", () => ({ usePathname: () => ruta.actual }));

import { MENSAJES_CORREO as M } from "../../pruebas/correo";
import { MenuPrincipal } from "../marco/menu-principal";

// Spec 028 · T7 (rojo; plan, Frontend). Entrada «Correo» del menú principal, junto a «Cambiar contraseña».
// Contrato (T13), `components/marco/menu-principal.tsx`: un enlace «Correo» a `/cuenta/correo`, UNA vez en el DOM, dentro del
// grupo secundario («Más», `#menu-mas`) donde está «Cambiar contraseña», SIN exigir ningún permiso (cualquier rol con estudio
// activo), con `aria-current="page"` en `/cuenta/correo` y objetivo táctil de 44 px (`min-h-11`).

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

describe("MenuPrincipal · «Correo» (028)", () => {
  it("hay un enlace «Correo» a /cuenta/correo, una sola vez", () => {
    pintar();
    const enlaces = screen.getAllByRole("link", { name: M.entradaMenu });
    expect(enlaces).toHaveLength(1);
    expect(enlaces[0]!.getAttribute("href")).toBe("/cuenta/correo");
  });

  it("no exige permisos: lo ven también el rol de solo lectura y quien no tiene ninguno", () => {
    for (const permisos of [["clientes.ver"], []]) {
      cleanup();
      pintar(permisos);
      expect(screen.getByRole("link", { name: M.entradaMenu }).getAttribute("href")).toBe("/cuenta/correo");
    }
  });

  it("va en el mismo grupo que «Cambiar contraseña»", () => {
    pintar();
    const correo = screen.getByRole("link", { name: M.entradaMenu });
    const contrasena = screen.getByRole("link", { name: "Cambiar contraseña" });
    expect(correo.parentElement).toBe(contrasena.parentElement);
  });

  it("está activa en /cuenta/correo y no en /cuenta/contrasena; objetivo táctil de 44 px", () => {
    ruta.actual = "/cuenta/correo";
    pintar();
    expect(screen.getByRole("link", { name: M.entradaMenu }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Cambiar contraseña" }).getAttribute("aria-current")).toBeNull();
    expect(screen.getByRole("link", { name: M.entradaMenu }).className).toContain("min-h-11");
  });
});

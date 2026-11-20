import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Yo } from "../../lib/acceso";

const ruta = vi.hoisted(() => ({ actual: "/clientes" }));
vi.mock("next/navigation", () => ({ usePathname: () => ruta.actual }));

import { MENSAJES_BANDEJA as B } from "../../pruebas/bandeja";
import { MenuPrincipal } from "./menu-principal";

// Spec 024 · T5 (rojo; D-10, CA-11). Entrada «Buzones» del menú principal.
// Contrato (T9), `components/marco/menu-principal.tsx`: un enlace «Buzones» a `/buzon`, solo con el permiso `buzon.ver`,
// UNA vez en el DOM (el CSS lo lleva a la barra inferior en celular y al menú lateral desde 1024 px, como Clientes y
// Trabajos: fuera del grupo «Más»), con `aria-current="page"` en `/buzon` (y bajo él), objetivo táctil de 44 px
// (`min-h-11`) y la misma clase de «activa» que las demás entradas.

const yo = (...permisos: string[]) => ({ permisos }) as unknown as Yo;

function pintar(permisos: string[] = ["clientes.ver", "buzon.ver"]) {
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

describe("MenuPrincipal · «Buzones» (024)", () => {
  it("con `buzon.ver`: enlace «Buzones» a /buzon, una sola vez", () => {
    pintar();
    const enlaces = screen.getAllByRole("link", { name: B.entradaMenu });
    expect(enlaces).toHaveLength(1);
    expect(enlaces[0]!.getAttribute("href")).toBe("/buzon");
  });

  it("sin `buzon.ver` no hay entrada (aunque sí pueda ver clientes)", () => {
    pintar(["clientes.ver"]);
    expect(screen.queryByRole("link", { name: B.entradaMenu })).toBeNull();
    expect(screen.getByRole("link", { name: "Clientes" })).toBeTruthy();
  });

  it("va en la barra principal junto a Clientes y Trabajos, no dentro del grupo «Más»", () => {
    pintar();
    const enlace = screen.getByRole("link", { name: B.entradaMenu });
    expect(enlace.closest("#menu-mas")).toBeNull();
    expect(screen.getByRole("link", { name: "Clientes" }).closest("#menu-mas")).toBeNull();
    expect(enlace.closest("nav")).toBe(screen.getByRole("navigation"));
  });

  it("está activa en /buzon (y en lo que cuelga de ella) y no en /clientes", () => {
    ruta.actual = "/buzon";
    pintar();
    const enlace = screen.getByRole("link", { name: B.entradaMenu });
    expect(enlace.getAttribute("aria-current")).toBe("page");
    expect(enlace.className).toContain("bg-primario-suave");
    expect(screen.getByRole("link", { name: "Clientes" }).getAttribute("aria-current")).toBeNull();
  });

  it("en /clientes/:id/buzon la activa es Clientes, no «Buzones» (es la bandeja fijada de ese cliente)", () => {
    ruta.actual = "/clientes/c-1/buzon";
    pintar();
    expect(screen.getByRole("link", { name: B.entradaMenu }).getAttribute("aria-current")).toBeNull();
    expect(screen.getByRole("link", { name: "Clientes" }).getAttribute("aria-current")).toBe("page");
  });

  it("tiene objetivo táctil de 44 px como las demás entradas de la barra", () => {
    pintar();
    expect(screen.getByRole("link", { name: B.entradaMenu }).className).toContain("min-h-11");
  });
});

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../../../../lib/sesion";
import {
  PERIODO,
  PERMISOS,
  RESUMEN_BASE,
  V290,
  instalarFetchVentas,
  paginaDe,
} from "../../../../../pruebas/ventas";

const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  prefetch: vi.fn(),
}));
const busqueda = vi.hoisted(() => ({ actual: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/clientes/c-1/ventas",
  useSearchParams: () => busqueda.actual,
  useParams: () => ({ clienteId: "c-1" }),
}));

// Spec 038 T18 (3): en celular «Generar archivo» queda fijo abajo (P-3); la pantalla deja espacio inferior, como compras.

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Ventas · espacio inferior para «Generar archivo» fijo", () => {
  it("la página lleva pb-28 en celular y vuelve a pb-6 desde md", async () => {
    busqueda.actual = new URLSearchParams(`periodo=${PERIODO}`);
    instalarFetchVentas({
      permisos: PERMISOS.todos,
      estado: { pagina: paginaDe([V290] as never), resumen: RESUMEN_BASE },
    });
    const modulo = (await import("./page")) as { default: () => ReactElement };
    const Pagina = modulo.default;
    render(<Pagina />);
    const boton = await screen.findByRole("button", { name: /Generar archivo/ });
    const principal = boton.closest("main") as HTMLElement;
    expect(principal.className).toContain("pb-28");
    expect(principal.className).toContain("md:pb-6");
  });
});

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import { asentar, rutaSesion, yoDe } from "../../pruebas/acceso";
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
import Clientes from "./clientes/page";

// Contrato (plan 007b, Archivos: `layout.tsx` y pantallas nuevas; D7, D10). Los enlaces a las pantallas
// nuevas aparecen según permisos (comodidad; la barrera es el backend):
// - Menú del layout: enlace "Trabajos" (href /trabajos) con `clientes.ver`.
// - /clientes: enlace "Importar clientes" (href /clientes/importar) con `clientes.crear`, junto a
//   "Nuevo cliente"; sin ese permiso no aparece.

const A = { id: "e-a", nombre: "Estudio Alfa" };

describe("enlaces a las pantallas de 007b", () => {
  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    reiniciarSesion();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("layout: «Trabajos» con clientes.ver y oculto sin permisos", async () => {
    const con: Record<string, Manejador> = {
      "GET /api/auth/sesion": { status: 200, cuerpo: sesionDe(A, "csrf-1") },
      "GET /api/auth/estudios": {
        status: 200,
        cuerpo: [{ ...A, ultimoUsado: true }],
      },
      "GET /api/acceso/yo": { status: 200, cuerpo: yoDe("lectura", ["clientes.ver"]) },
    };
    instalarFetchFalso(con);
    render(
      <LayoutApp>
        <p>contenido</p>
      </LayoutApp>,
    );
    const enlace = await screen.findByRole("link", { name: "Trabajos" });
    expect(enlace.getAttribute("href")).toBe("/trabajos");
    cleanup();
    vi.unstubAllGlobals();
    reiniciarSesion();

    instalarFetchFalso({
      ...con,
      "GET /api/acceso/yo": { status: 200, cuerpo: yoDe("lectura", []) },
    });
    render(
      <LayoutApp>
        <p>contenido</p>
      </LayoutApp>,
    );
    await screen.findByLabelText("Estudio");
    await asentar();
    expect(screen.queryByRole("link", { name: "Trabajos" })).toBeNull();
  });

  it("/clientes: «Importar clientes» solo con clientes.crear", async () => {
    const base = (permisos: string[]): Record<string, Manejador> => ({
      ...rutaSesion(),
      "GET /api/acceso/yo": { status: 200, cuerpo: yoDe("contador", permisos) },
      "GET /api/clientes": { status: 200, cuerpo: [] },
    });
    instalarFetchFalso(base(["clientes.ver", "clientes.crear"]));
    render(<Clientes />);
    const enlace = await screen.findByRole("link", {
      name: "Importar clientes",
    });
    expect(enlace.getAttribute("href")).toBe("/clientes/importar");
    cleanup();
    vi.unstubAllGlobals();
    reiniciarSesion();

    instalarFetchFalso(base(["clientes.ver"]));
    render(<Clientes />);
    await screen.findByRole("heading", { name: "Clientes" });
    await asentar();
    expect(screen.queryByRole("link", { name: "Importar clientes" })).toBeNull();
  });
});

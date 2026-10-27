import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import { asentar, yoDe } from "../../pruebas/acceso";
import {
  crearRouterFalso,
  instalarFetchFalso,
  sesionDe,
  type FetchFalso,
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

// Contrato (plan 005, Frontend; CA-15, RNF-007). Además del selector de estudio (004), el menú del
// layout pide `GET /api/acceso/yo` (con X-Estudio) y muestra enlaces según `permisos`, no según el
// rol: "Usuarios" (href /usuarios) con `usuarios.ver` y "Clientes" (href /clientes) con
// `clientes.ver`. Mientras `yo` carga, o si falla, no hay enlaces y NO aparece ninguna alerta ni se
// rompe el selector de estudio (las pruebas de 004 no simulan esta ruta). Ocultar es comodidad: la
// barrera sigue siendo el backend.

const A = { id: "e-a", nombre: "Estudio Alfa" };

function rutas(yo: Manejador): Record<string, Manejador> {
  return {
    "GET /api/auth/sesion": { status: 200, cuerpo: sesionDe(A, "csrf-1") },
    "GET /api/auth/estudios": {
      status: 200,
      cuerpo: [{ ...A, ultimoUsado: true }],
    },
    "GET /api/acceso/yo": yo,
  };
}

async function montar(yo: Manejador): Promise<FetchFalso> {
  const f = instalarFetchFalso(rutas(yo));
  render(
    <LayoutApp>
      <p>contenido de la página</p>
    </LayoutApp>,
  );
  await screen.findByLabelText("Estudio");
  await vi.waitFor(() => expect(f.de("GET /api/acceso/yo")).toHaveLength(1));
  await asentar();
  return f;
}

describe("(app)/layout · menú por permisos (005)", () => {
  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    reiniciarSesion();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("Dueño: muestra los enlaces Usuarios (/usuarios) y Clientes (/clientes)", async () => {
    await montar({ status: 200, cuerpo: yoDe("dueno") });
    const usuarios = await screen.findByRole("link", { name: "Usuarios" });
    const clientes = await screen.findByRole("link", { name: "Clientes" });
    expect(usuarios.getAttribute("href")).toBe("/usuarios");
    expect(clientes.getAttribute("href")).toBe("/clientes");
  });

  it("Asistente (sin usuarios.ver): muestra Clientes y oculta Usuarios", async () => {
    await montar({ status: 200, cuerpo: yoDe("asistente") });
    expect(await screen.findByRole("link", { name: "Clientes" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Usuarios" })).toBeNull();
  });

  it("sin permisos de usuarios ni de clientes oculta ambos enlaces", async () => {
    await montar({ status: 200, cuerpo: yoDe("lectura", []) });
    expect(screen.queryByRole("link", { name: "Usuarios" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Clientes" })).toBeNull();
  });

  it("decide por permisos, no por el nombre del rol (usuarios.ver sin clientes.ver)", async () => {
    await montar({
      status: 200,
      cuerpo: yoDe("contador", ["usuarios.ver"]),
    });
    expect(await screen.findByRole("link", { name: "Usuarios" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Clientes" })).toBeNull();
  });

  it("pide GET /api/acceso/yo con el estudio activo en X-Estudio", async () => {
    const f = await montar({ status: 200, cuerpo: yoDe("dueno") });
    const [llamada] = f.de("GET /api/acceso/yo");
    expect(llamada?.headers["x-estudio"]).toBe(A.id);
    expect(llamada?.credentials).toBe("same-origin");
  });

  it("si yo falla (403) no hay enlaces ni alerta, y el selector de estudio sigue activo", async () => {
    await montar({ status: 403, cuerpo: { codigo: "permiso_denegado" } });
    expect(screen.queryByRole("link", { name: "Usuarios" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Clientes" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("contenido de la página")).toBeTruthy();
    const selector = screen.getByLabelText("Estudio") as HTMLSelectElement;
    expect(selector.value).toBe(A.id);
  });
});

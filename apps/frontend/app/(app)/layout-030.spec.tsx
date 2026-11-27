import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import { asentar, yoDe } from "../../pruebas/acceso";
import { ID_PRACTICANTE, yoPropio } from "../../pruebas/roles";
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

// Contrato (plan 030, Alcance «Equipo → Roles»; U1, U3; RNF-007). Se suma a layout-acceso.spec.tsx de
// 005 (no lo reemplaza). El menú decide por permisos de `GET /api/acceso/yo`, nunca por el nombre del
// rol: el enlace "Roles" (href /usuarios/roles) aparece solo con `roles.gestionar`. Un miembro con rol
// propio (`rol: "propio"`, `rolPropio`) ve los enlaces que sus permisos efectivos permiten.

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

async function montar(cuerpo: unknown, status = 200): Promise<FetchFalso> {
  const f = instalarFetchFalso(rutas({ status, cuerpo }));
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

describe("(app)/layout · enlace Roles (030)", () => {
  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    reiniciarSesion();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("con roles.gestionar muestra Roles (/usuarios/roles) junto a Usuarios", async () => {
    await montar(yoDe("admin", ["usuarios.ver", "roles.gestionar"]));
    const roles = await screen.findByRole("link", { name: "Roles" });
    expect(roles.getAttribute("href")).toBe("/usuarios/roles");
    expect(screen.getByRole("link", { name: "Usuarios" })).toBeTruthy();
  });

  it("sin roles.gestionar no hay enlace Roles aunque gestione usuarios", async () => {
    await montar(yoDe("admin", ["usuarios.ver", "usuarios.gestionar"]));
    expect(await screen.findByRole("link", { name: "Usuarios" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Roles" })).toBeNull();
  });

  it("los cinco roles de sistema de 005 no ven Roles con su matriz actual", async () => {
    for (const rol of [
      "dueno",
      "admin",
      "contador",
      "asistente",
      "lectura",
    ] as const) {
      await montar(yoDe(rol));
      expect(screen.queryByRole("link", { name: "Roles" }), rol).toBeNull();
      cleanup();
      reiniciarSesion();
    }
  });

  it("un miembro con rol propio ve los enlaces que sus permisos efectivos permiten", async () => {
    await montar(
      yoPropio(
        ["clientes.ver", "usuarios.ver", "roles.gestionar"],
        "asignado",
        {
          id: ID_PRACTICANTE,
          nombre: "Practicante",
        },
      ),
    );
    expect(await screen.findByRole("link", { name: "Roles" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Clientes" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Usuarios" })).toBeTruthy();
  });

  it("un rol propio solo con clientes.ver no ve Usuarios ni Roles", async () => {
    await montar(
      yoPropio(["clientes.ver"], "asignado", {
        id: ID_PRACTICANTE,
        nombre: "Practicante",
      }),
    );
    expect(await screen.findByRole("link", { name: "Clientes" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Usuarios" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Roles" })).toBeNull();
  });

  it("si yo falla (403) no aparece Roles ni alerta", async () => {
    await montar({ codigo: "permiso_denegado" }, 403);
    expect(screen.queryByRole("link", { name: "Roles" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

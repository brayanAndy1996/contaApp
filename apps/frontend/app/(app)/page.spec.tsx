import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import { asentar, yoDe, type RolPrueba } from "../../pruebas/acceso";
import { usoDe } from "../../pruebas/planes";
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

import Inicio from "./page";

// Contrato (plan 006, Archivos; CA-10). Inicio del estudio ("/"):
// - Conserva el encabezado "ContApp".
// - Muestra el indicador de uso (<UsoPlan />, región "Uso del plan", GET /api/plan/uso).
// - Onboarding: al montar pide GET /api/acceso/yo y GET /api/clientes; si el estudio aún no tiene
//   clientes (lista vacía) muestra la sección "Primeros pasos" con enlaces: "Agrega tu primer cliente"
//   (href /clientes, con `clientes.ver`) e "Invita a tu equipo" (href /usuarios, con
//   `usuarios.gestionar`); un enlace cuyo permiso falta no se muestra. Con clientes, o si la carga
//   falla, no aparece (ni alertas). Es presentación: la barrera sigue en el backend.

const CLIENTE = {
  id: "c-1",
  razonSocial: "Cliente Uno SAC",
  ruc: "20123456789",
};

function rutas(
  rol: RolPrueba,
  clientes: Manejador,
  permisos?: string[],
): Record<string, Manejador> {
  return {
    "GET /api/auth/sesion": {
      status: 200,
      cuerpo: sesionDe({ id: "e-a", nombre: "Estudio Alfa" }, "csrf-inicio"),
    },
    "GET /api/acceso/yo": { status: 200, cuerpo: yoDe(rol, permisos) },
    "GET /api/clientes": clientes,
    "GET /api/plan/uso": { status: 200, cuerpo: usoDe() },
  };
}

describe("/ (inicio)", () => {
  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    reiniciarSesion();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("estudio sin clientes: 'Primeros pasos' con los enlaces para el Dueño", async () => {
    instalarFetchFalso(rutas("dueno", { status: 200, cuerpo: [] }));
    render(<Inicio />);
    expect(await screen.findByText("Primeros pasos")).toBeTruthy();
    const clientes = screen.getByRole("link", {
      name: "Agrega tu primer cliente",
    });
    const equipo = screen.getByRole("link", { name: "Invita a tu equipo" });
    expect(clientes.getAttribute("href")).toBe("/clientes");
    expect(equipo.getAttribute("href")).toBe("/usuarios");
  });

  it("sin usuarios.gestionar no ofrece invitar al equipo", async () => {
    instalarFetchFalso(
      rutas("lectura", { status: 200, cuerpo: [] }, ["clientes.ver"]),
    );
    render(<Inicio />);
    await screen.findByText("Primeros pasos");
    expect(
      screen.getByRole("link", { name: "Agrega tu primer cliente" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("link", { name: "Invita a tu equipo" }),
    ).toBeNull();
  });

  it("con clientes no muestra el onboarding", async () => {
    const f = instalarFetchFalso(
      rutas("dueno", { status: 200, cuerpo: [CLIENTE] }),
    );
    render(<Inicio />);
    await vi.waitFor(() => expect(f.de("GET /api/clientes")).toHaveLength(1));
    await asentar();
    expect(screen.queryByText("Primeros pasos")).toBeNull();
    expect(
      screen.queryByRole("link", { name: "Invita a tu equipo" }),
    ).toBeNull();
  });

  it("si falla la carga de clientes no muestra onboarding ni alertas", async () => {
    const f = instalarFetchFalso(rutas("dueno", { status: 500, cuerpo: {} }));
    render(<Inicio />);
    await vi.waitFor(() => expect(f.de("GET /api/clientes")).toHaveLength(1));
    await asentar();
    expect(screen.queryByText("Primeros pasos")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("conserva el encabezado y muestra el indicador de uso del plan", async () => {
    const f = instalarFetchFalso(
      rutas("dueno", { status: 200, cuerpo: [CLIENTE] }),
    );
    render(<Inicio />);
    expect(screen.getByRole("heading", { name: "ContApp" })).toBeTruthy();
    const uso = await screen.findByRole("region", { name: "Uso del plan" });
    expect(uso.textContent).toContain("RUCs: 12 de 100");
    expect(f.de("GET /api/plan/uso")).toHaveLength(1);
  });
});

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../../../lib/sesion";
import { asentar, rutaSesion, yoDe } from "../../../../pruebas/acceso";
import { crearRouterFalso, instalarFetchFalso } from "../../../../pruebas/soporte";

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
  usePathname: () => "/clientes/c-1",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ clienteId: "c-1" }),
}));

import Cliente from "./page";

// Spec 031 T4 (P-1; CA-10; HU-39): la ficha del cliente muestra «Ver historial» solo con `auditoria.ver`; el enlace
// abre la auditoría filtrada por ese cliente y sin límite de fechas (`/configuracion/auditoria?clienteId=…&todo=1`).

const CLIENTE = { id: "c-1", ruc: "20100000001", razonSocial: "Alfa SAC" };

function rutas(permisos: string[]) {
  return {
    ...rutaSesion(),
    "GET /api/acceso/yo": { status: 200, cuerpo: yoDe("dueno", permisos) },
    "GET /api/clientes/c-1": { status: 200, cuerpo: CLIENTE },
    "GET /api/clientes/c-1/asignaciones": { status: 200, cuerpo: [] },
    "GET /api/usuarios": { status: 200, cuerpo: [] },
  };
}

describe("/clientes/[clienteId] · historial (spec 031)", () => {
  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    reiniciarSesion();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("con `auditoria.ver`: «Ver historial» abre la auditoría del cliente, sin límite de fechas", async () => {
    instalarFetchFalso(rutas(["clientes.ver", "auditoria.ver"]));
    render(<Cliente />);
    await screen.findByText("Alfa SAC");
    const nav = await screen.findByRole("navigation", { name: "Registros del cliente" });
    const enlace = await within(nav).findByRole("link", { name: "Ver historial" });
    expect(enlace.getAttribute("href")).toBe("/configuracion/auditoria?clienteId=c-1&todo=1");
  });

  it("sin `auditoria.ver`: no hay «Ver historial» (solo oculta; el backend valida)", async () => {
    instalarFetchFalso(rutas(["clientes.ver", "reglas.ver"]));
    render(<Cliente />);
    await screen.findByText("Alfa SAC");
    const nav = await screen.findByRole("navigation", { name: "Registros del cliente" });
    // Cuando aparece otro enlace condicionado por permisos, `GET /acceso/yo` ya se resolvió.
    await within(nav).findByRole("link", { name: "Reglas aprendidas" });
    await asentar(60);
    expect(screen.queryByRole("link", { name: "Ver historial" })).toBeNull();
  });
});

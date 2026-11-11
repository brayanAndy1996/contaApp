import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../../../lib/sesion";
import {
  crearRouterFalso,
  instalarFetchFalso,
  sesionDe,
  type Manejador,
} from "../../../../pruebas/soporte";

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

import PaginaAuditoria from "./page";

// Spec 017 · T18a (P-2, P-3, P-4, P-6, P-7 y hora de Lima en la pantalla de auditoría).

const ESTUDIO = { id: "e-a", nombre: "Estudio Alfa" };
const U1 = "00000000-0000-4000-8000-0000000000a1";
const U2 = "00000000-0000-4000-8000-0000000000a2";
const CLIENTE = "00000000-0000-4000-8000-0000000000c1";
const ROSA = { id: U1, nombre: "Rosa Quispe", activo: true };
const BETO = { id: U2, nombre: "Beto Contador", activo: true };

const fila = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-0000000002${String(n).padStart(2, "0")}`,
  ocurridaEn: "2026-11-11T17:28:00.000Z",
  accion: "cliente.creado",
  actor: { tipo: "usuario", autor: ROSA, trabajoId: null },
  cliente: { id: CLIENTE, ruc: "20100000001", razonSocial: "Distribuidora Andina SAC" },
  entidad: "cliente",
  entidadId: CLIENTE,
  datos: { origen: "manual" },
  objetivo: null,
  ...extra,
});

function rutas(auditoria: Manejador): Record<string, Manejador> {
  return {
    "GET /api/auth/sesion": { status: 200, cuerpo: sesionDe(ESTUDIO) },
    "GET /api/auditoria": auditoria,
  };
}

beforeEach(() => {
  Object.assign(router, crearRouterFalso());
  reiniciarSesion();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("configuracion/auditoria · textos (P-2, P-3, P-4) y hora de Lima", () => {
  it("feliz: trabajo con nombre, estado traducido, miembro afectado, alta por invitación, cliente editado y fecha en Lima", async () => {
    instalarFetchFalso(
      rutas({
        status: 200,
        cuerpo: {
          items: [
            fila(1, {
              accion: "periodo.estado_cambiado",
              actor: { tipo: "trabajo", autor: BETO, trabajoId: U1 },
              datos: { libro: "compras", periodo: "202610", de: "abierto", a: "revisado" },
            }),
            fila(2, {
              accion: "miembro.rol_cambiado",
              cliente: null,
              datos: { de: "asistente", a: "dueno" },
              objetivo: BETO,
            }),
            fila(3, {
              accion: "miembro.alta",
              cliente: null,
              actor: { tipo: "usuario", autor: BETO, trabajoId: null },
              datos: { rol: "admin", via: "invitacion" },
              objetivo: BETO,
            }),
            fila(4, {
              accion: "cliente.editado",
              actor: { tipo: "trabajo", autor: null, trabajoId: U1 },
              datos: { cambios: { razon_social: ["Andina SAC", "Andina Perú SAC"], regimen: ["rg", null] } },
            }),
          ],
          siguiente: null,
        },
      }),
    );
    render(<PaginaAuditoria />);
    const tabla = await screen.findByRole("table", { name: "Registros de auditoría" });

    expect(within(tabla).getByText("Beto Contador (proceso automático)")).toBeTruthy();
    expect(within(tabla).getByText("Estado: Abierto → Revisado")).toBeTruthy();
    expect(within(tabla).getByText("Miembro: Beto Contador")).toBeTruthy();
    expect(within(tabla).getByText("Rol: Asistente → Dueño")).toBeTruthy();
    expect(within(tabla).getByText("Se unió al estudio")).toBeTruthy();
    expect(within(tabla).getByText("Rol: Administrador")).toBeTruthy();
    expect(within(tabla).getByText("Razón social: Andina SAC → Andina Perú SAC")).toBeTruthy();
    expect(within(tabla).getByText("Régimen: Régimen General (RG) → (vacío)")).toBeTruthy();
    expect(within(tabla).getByText("Proceso automático")).toBeTruthy();
    // 17:28 UTC = 12:28 p. m. en Lima.
    expect(within(tabla).getAllByText(/11\/11\/26,? 12:28\s?p\.\s?m\./)).toHaveLength(4);
    // Sin códigos crudos.
    expect(tabla.textContent).not.toMatch(/abierto|revisado|asistente|dueno|invitacion|razon_social|rg\b/);
  });

  it("P-7: la tabla vive dentro de un contenedor con desplazamiento propio y celdas con espacio", async () => {
    instalarFetchFalso(rutas({ status: 200, cuerpo: { items: [fila(1)], siguiente: null } }));
    render(<PaginaAuditoria />);
    const tabla = await screen.findByRole("table", { name: "Registros de auditoría" });
    expect(tabla.parentElement?.className).toContain("overflow-x-auto");
    expect(tabla.className).toMatch(/min-w-/);
    for (const celda of tabla.querySelectorAll("tbody td")) expect(celda.className).toContain("px-2");
  });
});

describe("configuracion/auditoria · «Cargar más» no pierde el foco (P-6)", () => {
  const PAGINA_1 = [fila(1), fila(2)];
  const PAGINA_2 = [fila(3, { cliente: { id: CLIENTE, ruc: "20100000001", razonSocial: "Tercera SAC" } })];

  it("feliz: con Enter el foco pasa a la primera fila nueva aunque el botón desaparezca en la última página", async () => {
    instalarFetchFalso(
      rutas((llamada) =>
        llamada.url.includes("cursor=c2")
          ? { status: 200, cuerpo: { items: PAGINA_2, siguiente: null } }
          : { status: 200, cuerpo: { items: PAGINA_1, siguiente: "c2" } },
      ),
    );
    render(<PaginaAuditoria />);
    const user = userEvent.setup();
    const mas = await screen.findByRole("button", { name: "Cargar más" });
    mas.focus();
    await user.keyboard("{Enter}");
    const celda = await screen.findByText("Tercera SAC");
    await vi.waitFor(() => expect(document.activeElement).toBe(celda.closest("tr")));
    expect(screen.queryByRole("button", { name: "Cargar más" })).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
  });

  it("error: si la carga falla, el foco queda en «Reintentar» y al reintentar pasa a la fila nueva", async () => {
    let intentos = 0;
    instalarFetchFalso(
      rutas((llamada) => {
        if (!llamada.url.includes("cursor=c2")) {
          return { status: 200, cuerpo: { items: PAGINA_1, siguiente: "c2" } };
        }
        intentos += 1;
        return intentos === 1
          ? { status: 500, cuerpo: {} }
          : { status: 200, cuerpo: { items: PAGINA_2, siguiente: null } };
      }),
    );
    render(<PaginaAuditoria />);
    const user = userEvent.setup();
    const mas = await screen.findByRole("button", { name: "Cargar más" });
    mas.focus();
    await user.keyboard("{Enter}");
    const reintentar = await screen.findByRole("button", { name: "Reintentar" });
    await vi.waitFor(() => expect(document.activeElement).toBe(reintentar));

    await user.keyboard("{Enter}");
    const celda = await screen.findByText("Tercera SAC");
    await vi.waitFor(() => expect(document.activeElement).toBe(celda.closest("tr")));
  });
});

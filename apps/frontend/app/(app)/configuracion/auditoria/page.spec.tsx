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

// Spec 017 T13 (P-2; CA-12, CA-14, nivel C): la tabla muestra fecha, actor con nombre, acción en español, cliente y
// detalle, con «Cargar más»; sin `auditoria.ver` el backend da 403 y la página lo dice sin mostrar datos.

const ESTUDIO = { id: "e-a", nombre: "Estudio Alfa" };
const U1 = "00000000-0000-4000-8000-0000000000a1";
const CLIENTE = "00000000-0000-4000-8000-0000000000c1";

const fila = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-00000000010${n}`,
  ocurridaEn: `2026-11-1${n}T15:00:00.000Z`,
  accion: "cliente.creado",
  actor: {
    tipo: "usuario",
    autor: { id: U1, nombre: "Rosa Quispe", activo: true },
    trabajoId: null,
  },
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

describe("configuracion/auditoria", () => {
  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    reiniciarSesion();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("feliz: tabla con actor con nombre, acción en español y «Cargar más» con el cursor", async () => {
    let llamada = 0;
    const f = instalarFetchFalso(
      rutas(() => {
        llamada += 1;
        return llamada === 1
          ? {
              status: 200,
              cuerpo: {
                items: [
                  fila(1),
                  fila(2, {
                    accion: "credencial.descifrada",
                    actor: { tipo: "trabajo", autor: null, trabajoId: U1 },
                    cliente: null,
                    datos: { periodo: "202610", tipo: "sol" },
                  }),
                ],
                siguiente: "cursor-2",
              },
            }
          : {
              status: 200,
              cuerpo: {
                items: [
                  fila(3, {
                    accion: "miembro.desactivado",
                    actor: {
                      tipo: "usuario",
                      autor: { id: U1, nombre: null, activo: false },
                      trabajoId: null,
                    },
                    cliente: null,
                    datos: {},
                  }),
                ],
                siguiente: null,
              },
            };
      }),
    );
    render(<PaginaAuditoria />);

    const tabla = await screen.findByRole("table", { name: "Registros de auditoría" });
    expect(within(tabla).getByText("Rosa Quispe")).toBeTruthy();
    expect(within(tabla).getByText("Creó un cliente")).toBeTruthy();
    expect(within(tabla).getByText("Distribuidora Andina SAC")).toBeTruthy();
    expect(within(tabla).getByText("Proceso automático")).toBeTruthy();
    expect(within(tabla).getByText("Descifró una credencial")).toBeTruthy();
    expect(within(tabla).getByText("Periodo: 202610")).toBeTruthy();
    // Ningún código de acción ni id crudo en pantalla.
    expect(tabla.textContent).not.toContain("cliente.creado");
    expect(tabla.textContent).not.toContain(U1);

    await userEvent.setup().click(screen.getByRole("button", { name: "Cargar más" }));
    expect(await within(tabla).findByText("Desactivó a un miembro")).toBeTruthy();
    expect(within(tabla).getByText("Usuario desconocido")).toBeTruthy();
    expect(f.de("GET /api/auditoria")[1]?.url).toContain("cursor=cursor-2");
    expect(screen.queryByRole("button", { name: "Cargar más" })).toBeNull();
  });

  it("error: sin `auditoria.ver` (403) avisa sin mostrar datos; un fallo del servidor ofrece reintentar", async () => {
    instalarFetchFalso(rutas({ status: 403, cuerpo: { statusCode: 403 } }));
    render(<PaginaAuditoria />);
    expect((await screen.findByRole("alert")).textContent).toBe("No tienes permiso para ver la auditoría.");
    expect(screen.queryByRole("table")).toBeNull();
    cleanup();

    instalarFetchFalso(rutas({ status: 500, cuerpo: {} }));
    render(<PaginaAuditoria />);
    expect((await screen.findByRole("alert")).textContent).toContain("No se pudo cargar la auditoría");
    expect(screen.getByRole("button", { name: "Reintentar" })).toBeTruthy();
  });
});

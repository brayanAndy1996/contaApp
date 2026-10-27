import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../../../lib/sesion";
import {
  MENSAJES_ACCESO,
  asentar,
  celdas,
  esperarFila,
  rutaSesion,
  yoDe,
  type RolPrueba,
} from "../../../../pruebas/acceso";
import {
  crearRouterFalso,
  instalarFetchFalso,
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
  usePathname: () => "/clientes/c-1",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ clienteId: "c-1" }),
}));

import Cliente from "./page";

// Contrato (plan 005, Frontend; CA-5, CA-7, CA-15, D18). Pantalla /clientes/:clienteId; el id sale de
// `useParams()` de next/navigation (clave `clienteId`):
// - Al montar: GET /api/acceso/yo y GET /api/clientes/c-1 → muestra razón social y RUC.
//   403 → sinPermiso; 404 (inexistente, ajeno o no asignado: mismo caso) → noEncontrado; ninguna
//   otra sección en esos casos.
// - Con `clientes.asignar`: GET /api/clientes/c-1/asignaciones y GET /api/usuarios. Tabla de
//   asignaciones (role=row): celdas con nombre y tipo ("Responsable" | "Colaborador") y botón "Quitar"
//   por fila (DELETE /api/clientes/c-1/asignaciones/:usuarioId → 204, y recarga).
// - Formulario: select "Usuario" (miembros activos, value = usuarioId), select "Tipo" (colaborador |
//   responsable; por defecto colaborador) y botón "Asignar" → PUT /api/clientes/c-1/asignaciones/:id
//   { tipo, anterior? }. Si Tipo = responsable y YA hay otro responsable, aparece el select
//   "Responsable anterior" (colaborador | retirar; por defecto colaborador) y se envía `anterior`;
//   si no hay responsable, no aparece y no se envía.
// - Sin `clientes.asignar`: solo el detalle; no se piden asignaciones ni usuarios.
// - Errores: 409 miembro_no_asignable → miembroNoAsignable; 403 → sinPermiso; 404 → noEncontrado.

const CLIENTE = { id: "c-1", ruc: "20100000001", razonSocial: "Alfa SAC" };
const CON_RESPONSABLE = [
  { usuarioId: "u-con", nombre: "Carlos Contador", tipo: "responsable" },
  { usuarioId: "u-ase", nombre: "Asia Asistente", tipo: "colaborador" },
];
const SIN_RESPONSABLE = [
  { usuarioId: "u-ase", nombre: "Asia Asistente", tipo: "colaborador" },
];
const USUARIOS = [
  {
    usuarioId: "u-con",
    nombre: "Carlos Contador",
    correo: "carlos@estudio.test",
    rol: "contador",
    activo: true,
    esYo: false,
  },
  {
    usuarioId: "u-ase",
    nombre: "Asia Asistente",
    correo: "asia@estudio.test",
    rol: "asistente",
    activo: true,
    esYo: false,
  },
  {
    usuarioId: "u-bet",
    nombre: "Beto Contador",
    correo: "beto@estudio.test",
    rol: "contador",
    activo: true,
    esYo: false,
  },
  {
    usuarioId: "u-off",
    nombre: "Olga Desactivada",
    correo: "olga@estudio.test",
    rol: "contador",
    activo: false,
    esYo: false,
  },
];

function rutas(
  rol: RolPrueba,
  asignaciones: unknown[] = CON_RESPONSABLE,
  extra: Record<string, Manejador> = {},
): Record<string, Manejador> {
  return {
    ...rutaSesion(),
    "GET /api/acceso/yo": { status: 200, cuerpo: yoDe(rol) },
    "GET /api/clientes/c-1": { status: 200, cuerpo: CLIENTE },
    "GET /api/clientes/c-1/asignaciones": { status: 200, cuerpo: asignaciones },
    "GET /api/usuarios": { status: 200, cuerpo: USUARIOS },
    ...extra,
  };
}

async function listo() {
  await esperarFila("Asia Asistente");
  await vi.waitFor(() =>
    expect(
      (screen.getByLabelText("Usuario") as HTMLSelectElement).options.length,
    ).toBeGreaterThan(1),
  );
}

describe("/clientes/[clienteId]", () => {
  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    reiniciarSesion();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("Dueño: muestra razón social, RUC y las asignaciones con su tipo", async () => {
    instalarFetchFalso(rutas("dueno"));
    render(<Cliente />);
    expect(await screen.findByText("Alfa SAC")).toBeTruthy();
    expect(screen.getByText(/20100000001/)).toBeTruthy();
    const carlos = await esperarFila("Carlos Contador");
    expect(celdas(carlos)).toContain("Responsable");
    const asia = await esperarFila("Asia Asistente");
    expect(celdas(asia)).toContain("Colaborador");
    expect(within(asia).getByRole("button", { name: "Quitar" })).toBeTruthy();
  });

  it("Asistente (sin clientes.asignar): solo el detalle; no pide asignaciones ni usuarios", async () => {
    const f = instalarFetchFalso(rutas("asistente"));
    render(<Cliente />);
    expect(await screen.findByText("Alfa SAC")).toBeTruthy();
    await asentar();
    expect(f.de("GET /api/clientes/c-1/asignaciones")).toHaveLength(0);
    expect(f.de("GET /api/usuarios")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Asignar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Quitar" })).toBeNull();
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
  });

  it("el select Usuario ofrece solo miembros activos", async () => {
    instalarFetchFalso(rutas("dueno"));
    render(<Cliente />);
    await listo();
    const opciones = [
      ...(screen.getByLabelText("Usuario") as HTMLSelectElement).options,
    ]
      .map((o) => o.value)
      .filter(Boolean)
      .sort();
    expect(opciones).toEqual(["u-ase", "u-bet", "u-con"]);
  });

  it("asignar colaborador: PUT /api/clientes/c-1/asignaciones/:usuarioId {tipo} con X-CSRF-Token y recarga", async () => {
    const f = instalarFetchFalso(
      rutas("dueno", CON_RESPONSABLE, {
        "PUT /api/clientes/c-1/asignaciones/u-bet": {
          status: 200,
          cuerpo: [
            ...CON_RESPONSABLE,
            {
              usuarioId: "u-bet",
              nombre: "Beto Contador",
              tipo: "colaborador",
            },
          ],
        },
      }),
    );
    render(<Cliente />);
    await listo();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Usuario"), "u-bet");
    await user.click(screen.getByRole("button", { name: "Asignar" }));
    await vi.waitFor(() =>
      expect(f.de("PUT /api/clientes/c-1/asignaciones/u-bet")).toHaveLength(1),
    );
    const [llamada] = f.de("PUT /api/clientes/c-1/asignaciones/u-bet");
    expect(llamada?.body).toEqual({ tipo: "colaborador" });
    expect(llamada?.headers["x-csrf-token"]).toBe("csrf-acceso-1");
  });

  it.each([
    ["colaborador", undefined],
    ["retirar", "retirar"],
  ] as const)(
    "responsable nuevo con otro responsable vigente: pide 'Responsable anterior' (elección %s) y lo envía",
    async (_nombre, eleccion) => {
      const f = instalarFetchFalso(
        rutas("dueno", CON_RESPONSABLE, {
          "PUT /api/clientes/c-1/asignaciones/u-bet": {
            status: 200,
            cuerpo: CON_RESPONSABLE,
          },
        }),
      );
      render(<Cliente />);
      await listo();
      const user = userEvent.setup();
      await user.selectOptions(screen.getByLabelText("Usuario"), "u-bet");
      expect(screen.queryByLabelText("Responsable anterior")).toBeNull();
      await user.selectOptions(screen.getByLabelText("Tipo"), "responsable");
      const anterior = screen.getByLabelText(
        "Responsable anterior",
      ) as HTMLSelectElement;
      expect([...anterior.options].map((o) => o.value).sort()).toEqual([
        "colaborador",
        "retirar",
      ]);
      expect(anterior.value).toBe("colaborador");
      if (eleccion) await user.selectOptions(anterior, eleccion);
      await user.click(screen.getByRole("button", { name: "Asignar" }));
      await vi.waitFor(() =>
        expect(f.de("PUT /api/clientes/c-1/asignaciones/u-bet")).toHaveLength(
          1,
        ),
      );
      const [llamada] = f.de("PUT /api/clientes/c-1/asignaciones/u-bet");
      expect(llamada?.body).toEqual({
        tipo: "responsable",
        anterior: eleccion ?? "colaborador",
      });
    },
  );

  it("responsable cuando no hay otro: no aparece 'Responsable anterior' y no se envía `anterior`", async () => {
    const f = instalarFetchFalso(
      rutas("dueno", SIN_RESPONSABLE, {
        "PUT /api/clientes/c-1/asignaciones/u-bet": {
          status: 200,
          cuerpo: SIN_RESPONSABLE,
        },
      }),
    );
    render(<Cliente />);
    await listo();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Usuario"), "u-bet");
    await user.selectOptions(screen.getByLabelText("Tipo"), "responsable");
    expect(screen.queryByLabelText("Responsable anterior")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Asignar" }));
    await vi.waitFor(() =>
      expect(f.de("PUT /api/clientes/c-1/asignaciones/u-bet")).toHaveLength(1),
    );
    const [llamada] = f.de("PUT /api/clientes/c-1/asignaciones/u-bet");
    expect(llamada?.body).toEqual({ tipo: "responsable" });
    expect(Object.keys(llamada?.body as object)).toEqual(["tipo"]);
  });

  it("quitar: DELETE /api/clientes/c-1/asignaciones/:usuarioId (204) y recarga la lista", async () => {
    const f = instalarFetchFalso(
      rutas("dueno", CON_RESPONSABLE, {
        "DELETE /api/clientes/c-1/asignaciones/u-ase": { status: 204 },
        "GET /api/clientes/c-1/asignaciones": (_l, vez) => ({
          status: 200,
          cuerpo: vez === 1 ? CON_RESPONSABLE : [CON_RESPONSABLE[0]],
        }),
      }),
    );
    render(<Cliente />);
    const asia = await esperarFila("Asia Asistente");
    const user = userEvent.setup();
    await user.click(within(asia).getByRole("button", { name: "Quitar" }));
    await vi.waitFor(() =>
      expect(f.de("DELETE /api/clientes/c-1/asignaciones/u-ase")).toHaveLength(
        1,
      ),
    );
    const [llamada] = f.de("DELETE /api/clientes/c-1/asignaciones/u-ase");
    expect(llamada?.headers["x-csrf-token"]).toBe("csrf-acceso-1");
    await vi.waitFor(() =>
      expect(
        screen
          .queryAllByRole("row")
          .some((r) => r.textContent?.includes("Asia Asistente")),
      ).toBe(false),
    );
    expect(f.de("GET /api/clientes/c-1/asignaciones")).toHaveLength(2);
  });

  it("404 al leer el cliente (inexistente, ajeno o no asignado): mensaje genérico y sin formulario", async () => {
    instalarFetchFalso(
      rutas("asistente", [], {
        "GET /api/clientes/c-1": {
          status: 404,
          cuerpo: { codigo: "no_encontrado" },
        },
        "GET /api/clientes/c-1/asignaciones": {
          status: 404,
          cuerpo: { codigo: "no_encontrado" },
        },
      }),
    );
    const { container } = render(<Cliente />);
    expect(await screen.findByText(MENSAJES_ACCESO.noEncontrado)).toBeTruthy();
    expect(container.textContent).not.toContain("no_encontrado");
    expect(screen.queryByRole("button", { name: "Asignar" })).toBeNull();
    expect(screen.queryByText("Alfa SAC")).toBeNull();
  });

  it("403 al leer el cliente: mensaje genérico de permiso", async () => {
    instalarFetchFalso(
      rutas("lectura", [], {
        "GET /api/clientes/c-1": {
          status: 403,
          cuerpo: { codigo: "permiso_denegado" },
        },
      }),
    );
    const { container } = render(<Cliente />);
    expect(await screen.findByText(MENSAJES_ACCESO.sinPermiso)).toBeTruthy();
    expect(container.textContent).not.toContain("permiso_denegado");
  });

  it("asignar: 409 miembro_no_asignable → mensaje propio; 404 → genérico", async () => {
    instalarFetchFalso(
      rutas("dueno", CON_RESPONSABLE, {
        "PUT /api/clientes/c-1/asignaciones/u-bet": (_l, vez) =>
          vez === 1
            ? { status: 409, cuerpo: { codigo: "miembro_no_asignable" } }
            : { status: 404, cuerpo: { codigo: "no_encontrado" } },
      }),
    );
    render(<Cliente />);
    await listo();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Usuario"), "u-bet");
    await user.click(screen.getByRole("button", { name: "Asignar" }));
    expect(
      await screen.findByText(MENSAJES_ACCESO.miembroNoAsignable),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Asignar" }));
    expect(await screen.findByText(MENSAJES_ACCESO.noEncontrado)).toBeTruthy();
  });
});

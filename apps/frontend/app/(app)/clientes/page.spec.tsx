import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../../lib/sesion";
import {
  MENSAJES_ACCESO,
  asentar,
  celdas,
  esperarFila,
  rutaSesion,
  yoDe,
  type RolPrueba,
} from "../../../pruebas/acceso";
import {
  crearRouterFalso,
  instalarFetchFalso,
  type Manejador,
} from "../../../pruebas/soporte";

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
  usePathname: () => "/clientes",
  useSearchParams: () => new URLSearchParams(),
}));

import Clientes from "./page";

// Contrato (plan 005, Frontend; CA-5, CA-7, CA-8, CA-15, D18). Pantalla /clientes:
// - Al montar: GET /api/acceso/yo y GET /api/clientes (ya filtrado por alcance en el backend).
//   Tabla (role=row): celdas con RUC, razón social y responsable (nombre o "Sin responsable");
//   la razón social es un enlace a /clientes/:id.
// - Con `clientes.asignar` (asignación masiva, D20): además GET /api/usuarios; una casilla por fila
//   "Seleccionar <razón social>", select "Usuario" (solo miembros activos; value = usuarioId),
//   select "Tipo" (value colaborador | responsable; por defecto colaborador), y botón "Asignar
//   seleccionados" (deshabilitado sin selección). Con Tipo = responsable aparece el select
//   "Responsable anterior" (value colaborador | retirar; por defecto colaborador).
// - Enviar: POST /api/asignaciones/por-usuario { usuarioId, clienteIds, tipo, anterior? } (anterior
//   solo si tipo = responsable). 200 {asignados} → MENSAJES_ACCESO.asignados(n) y recarga GET /api/clientes.
// - Sin `clientes.asignar`: sin casillas, sin selects, sin botón y sin pedir /api/usuarios.
// - Errores (role=alert o texto): 403 → sinPermiso; 404 → noEncontrado (nada se aplicó: el backend no
//   dice qué ID falló); 409 miembro_no_asignable → miembroNoAsignable; otro → errorGeneral.

const CLIENTES = [
  {
    id: "c-1",
    ruc: "20100000001",
    razonSocial: "Alfa SAC",
    responsable: { usuarioId: "u-con", nombre: "Carlos Contador" },
  },
  { id: "c-2", ruc: "20100000002", razonSocial: "Beta SRL", responsable: null },
  {
    id: "c-3",
    ruc: "20100000003",
    razonSocial: "Gamma EIRL",
    responsable: null,
  },
];
const USUARIOS = [
  {
    usuarioId: "u-yo",
    nombre: "Dora Dueña",
    correo: "dora@estudio.test",
    rol: "dueno",
    activo: true,
    esYo: true,
  },
  {
    usuarioId: "u-con",
    nombre: "Carlos Contador",
    correo: "carlos@estudio.test",
    rol: "contador",
    activo: true,
    esYo: false,
  },
  {
    usuarioId: "u-bet",
    nombre: "Beto Asistente",
    correo: "beto@estudio.test",
    rol: "asistente",
    activo: true,
    esYo: false,
  },
  {
    usuarioId: "u-off",
    nombre: "Olga Desactivada",
    correo: "olga@estudio.test",
    rol: "asistente",
    activo: false,
    esYo: false,
  },
];

function rutas(
  rol: RolPrueba,
  extra: Record<string, Manejador> = {},
): Record<string, Manejador> {
  return {
    ...rutaSesion(),
    "GET /api/acceso/yo": { status: 200, cuerpo: yoDe(rol) },
    "GET /api/clientes": { status: 200, cuerpo: CLIENTES },
    "GET /api/usuarios": { status: 200, cuerpo: USUARIOS },
    ...extra,
  };
}

async function seleccionar(...nombres: string[]) {
  const user = userEvent.setup();
  for (const nombre of nombres) {
    await user.click(screen.getByLabelText(`Seleccionar ${nombre}`));
  }
  return user;
}

describe("/clientes", () => {
  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    reiniciarSesion();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("lista RUC, razón social y responsable (o 'Sin responsable'), con enlace al detalle", async () => {
    instalarFetchFalso(rutas("asistente"));
    render(<Clientes />);
    const alfa = await esperarFila("Alfa SAC");
    expect(celdas(alfa)).toContain("20100000001");
    expect(alfa.textContent).toContain("Carlos Contador");
    const enlace = within(alfa).getByRole("link", { name: "Alfa SAC" });
    expect(enlace.getAttribute("href")).toBe("/clientes/c-1");
    const beta = await esperarFila("Beta SRL");
    expect(beta.textContent).toContain(MENSAJES_ACCESO.sinResponsable);
    expect(
      within(beta).getByRole("link", { name: "Beta SRL" }).getAttribute("href"),
    ).toBe("/clientes/c-2");
  });

  it("sin clientes.asignar (Asistente): sin casillas, selects ni botón, y no pide los usuarios", async () => {
    const f = instalarFetchFalso(rutas("asistente"));
    render(<Clientes />);
    await esperarFila("Alfa SAC");
    await asentar();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
    expect(
      screen.queryByRole("button", { name: "Asignar seleccionados" }),
    ).toBeNull();
    expect(f.de("GET /api/usuarios")).toHaveLength(0);
  });

  it("Administrador: casillas por cliente y selects con solo miembros activos; botón deshabilitado sin selección", async () => {
    const f = instalarFetchFalso(rutas("admin"));
    render(<Clientes />);
    await esperarFila("Alfa SAC");
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
    const usuario = (await screen.findByLabelText(
      "Usuario",
    )) as HTMLSelectElement;
    await vi.waitFor(() =>
      expect(
        [...(screen.getByLabelText("Usuario") as HTMLSelectElement).options]
          .map((o) => o.value)
          .filter(Boolean)
          .sort(),
      ).toEqual(["u-bet", "u-con", "u-yo"]),
    );
    expect(usuario).toBeTruthy();
    const boton = screen.getByRole("button", {
      name: "Asignar seleccionados",
    }) as HTMLButtonElement;
    expect(boton.disabled).toBe(true);
    expect(screen.queryByLabelText("Responsable anterior")).toBeNull();
    expect(f.de("POST /api/asignaciones/por-usuario")).toHaveLength(0);
  });

  it("asignación masiva de colaborador: POST /api/asignaciones/por-usuario con los IDs elegidos, mensaje y recarga", async () => {
    const f = instalarFetchFalso(
      rutas("dueno", {
        "POST /api/asignaciones/por-usuario": {
          status: 200,
          cuerpo: { asignados: 2 },
        },
      }),
    );
    render(<Clientes />);
    await esperarFila("Alfa SAC");
    await vi.waitFor(() =>
      expect(
        (screen.getByLabelText("Usuario") as HTMLSelectElement).options.length,
      ).toBeGreaterThan(1),
    );
    const user = await seleccionar("Alfa SAC", "Gamma EIRL");
    await user.selectOptions(screen.getByLabelText("Usuario"), "u-bet");
    await user.click(
      screen.getByRole("button", { name: "Asignar seleccionados" }),
    );
    await screen.findByText(MENSAJES_ACCESO.asignados(2));
    const [llamada] = f.de("POST /api/asignaciones/por-usuario");
    const cuerpo = llamada?.body as {
      usuarioId: string;
      clienteIds: string[];
      tipo: string;
    };
    expect(cuerpo.usuarioId).toBe("u-bet");
    expect(cuerpo.tipo).toBe("colaborador");
    expect([...cuerpo.clienteIds].sort()).toEqual(["c-1", "c-3"]);
    expect(Object.keys(cuerpo).sort()).toEqual([
      "clienteIds",
      "tipo",
      "usuarioId",
    ]);
    expect(llamada?.headers["x-csrf-token"]).toBe("csrf-acceso-1");
    await vi.waitFor(() => expect(f.de("GET /api/clientes")).toHaveLength(2));
  });

  it.each([
    ["colaborador", undefined],
    ["retirar", "retirar"],
  ] as const)(
    "asignación masiva de responsable: Tipo=responsable muestra 'Responsable anterior' (elección %s)",
    async (_nombre, eleccion) => {
      const f = instalarFetchFalso(
        rutas("dueno", {
          "POST /api/asignaciones/por-usuario": {
            status: 200,
            cuerpo: { asignados: 1 },
          },
        }),
      );
      render(<Clientes />);
      await esperarFila("Alfa SAC");
      await vi.waitFor(() =>
        expect(
          (screen.getByLabelText("Usuario") as HTMLSelectElement).options
            .length,
        ).toBeGreaterThan(1),
      );
      const user = await seleccionar("Alfa SAC");
      await user.selectOptions(screen.getByLabelText("Usuario"), "u-bet");
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
      await user.click(
        screen.getByRole("button", { name: "Asignar seleccionados" }),
      );
      await screen.findByText(MENSAJES_ACCESO.asignados(1));
      const [llamada] = f.de("POST /api/asignaciones/por-usuario");
      expect(llamada?.body).toEqual({
        usuarioId: "u-bet",
        clienteIds: ["c-1"],
        tipo: "responsable",
        anterior: eleccion ?? "colaborador",
      });
    },
  );

  it("404 (algún ID no visible o inexistente): mensaje genérico y no anuncia asignaciones", async () => {
    instalarFetchFalso(
      rutas("dueno", {
        "POST /api/asignaciones/por-usuario": {
          status: 404,
          cuerpo: { codigo: "no_encontrado" },
        },
      }),
    );
    const { container } = render(<Clientes />);
    await esperarFila("Alfa SAC");
    await vi.waitFor(() =>
      expect(
        (screen.getByLabelText("Usuario") as HTMLSelectElement).options.length,
      ).toBeGreaterThan(1),
    );
    const user = await seleccionar("Beta SRL");
    await user.selectOptions(screen.getByLabelText("Usuario"), "u-bet");
    await user.click(
      screen.getByRole("button", { name: "Asignar seleccionados" }),
    );
    expect(await screen.findByText(MENSAJES_ACCESO.noEncontrado)).toBeTruthy();
    expect(container.textContent).not.toContain("Clientes asignados");
    expect(container.textContent).not.toContain("no_encontrado");
  });

  it("409 miembro_no_asignable y 403 muestran su mensaje genérico", async () => {
    instalarFetchFalso(
      rutas("dueno", {
        "POST /api/asignaciones/por-usuario": (_l, vez) =>
          vez === 1
            ? { status: 409, cuerpo: { codigo: "miembro_no_asignable" } }
            : { status: 403, cuerpo: { codigo: "permiso_denegado" } },
      }),
    );
    render(<Clientes />);
    await esperarFila("Alfa SAC");
    await vi.waitFor(() =>
      expect(
        (screen.getByLabelText("Usuario") as HTMLSelectElement).options.length,
      ).toBeGreaterThan(1),
    );
    const user = await seleccionar("Beta SRL");
    await user.selectOptions(screen.getByLabelText("Usuario"), "u-bet");
    const enviar = () =>
      user.click(screen.getByRole("button", { name: "Asignar seleccionados" }));
    await enviar();
    expect(
      await screen.findByText(MENSAJES_ACCESO.miembroNoAsignable),
    ).toBeTruthy();
    await enviar();
    expect(await screen.findByText(MENSAJES_ACCESO.sinPermiso)).toBeTruthy();
  });

  it("si la lista falla con 403 muestra el mensaje de permiso y ninguna fila", async () => {
    instalarFetchFalso(
      rutas("lectura", {
        "GET /api/clientes": {
          status: 403,
          cuerpo: { codigo: "permiso_denegado" },
        },
      }),
    );
    render(<Clientes />);
    expect(await screen.findByText(MENSAJES_ACCESO.sinPermiso)).toBeTruthy();
    expect(screen.queryAllByRole("row").length).toBeLessThanOrEqual(1);
  });
});

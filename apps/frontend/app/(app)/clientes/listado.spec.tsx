import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../../lib/sesion";
import {
  asentar,
  esperarFila,
  rutaSesion,
  yoDe,
} from "../../../pruebas/acceso";
import { clienteDe } from "../../../pruebas/clientes";
import {
  crearRouterFalso,
  instalarFetchFalso,
  type FetchFalso,
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

// Contrato (plan 007a, shared y HTTP; D7, D10; CA-9). Pantalla /clientes, además de lo de 005:
// - Filtros (D7), todos con etiqueta accesible:
//   · select "Responsable": "" (Todos), "ninguno" (Sin responsable) y un usuarioId por cada miembro
//     activo de GET /api/usuarios (solo se pide con `usuarios.ver`; sin él, solo "" y "ninguno");
//   · select "Credencial": "" (Todas) | no_configurada | configurada | verificada | invalida;
//   · casilla "Mostrar archivados" → `archivados=1`;
//   · cuadro de texto "Buscar" (role=textbox) → `q` (recortado; se envía a lo sumo ~500 ms después
//     de escribir; máx. 100 caracteres).
//   Cada cambio vuelve a pedir GET /api/clientes con los parámetros de query de los filtros activos
//   y solo esos (sin `responsable=` vacío ni `archivados=0`); la primera carga va sin parámetros.
//   Los filtros se combinan; volver a "" / desmarcar quita el parámetro.
// - Cada fila muestra el estado de ambas credenciales como texto: "SOL: <etiqueta>" y
//   "SIRE API: <etiqueta>" (ETIQUETA_ESTADO). Un cliente archivado muestra el texto "Archivado".
// - Acciones según permiso: el enlace "Nuevo cliente" (href /clientes/nuevo) solo con `clientes.crear`.
// - Con `clientes.archivar`: botón "Archivar" por fila ACTIVA y "Reactivar" por fila archivada que
//   llevan al detalle (enlace a /clientes/:id); la confirmación vive en el detalle. Sin el permiso,
//   ninguno de los dos.
// - Solo depende de la API (/api/...) y de @contapp/shared.

const ESTADOS: Record<string, unknown> = {
  "c-1": clienteDe({
    id: "c-1",
    ruc: "20100000009",
    razonSocial: "Alfa SAC",
    responsable: { id: "u-con", nombre: "Carlos Contador" },
    credenciales: { sol: "verificada", sire_api: "no_configurada" },
  }),
  "c-2": clienteDe({
    id: "c-2",
    ruc: "20600000005",
    razonSocial: "Beta SRL",
    credenciales: { sol: "invalida", sire_api: "configurada" },
  }),
};
const ACTIVOS = Object.values(ESTADOS);
const ARCHIVADO = clienteDe({
  id: "c-9",
  ruc: "10123456781",
  razonSocial: "Zeta EIRL",
  archivado: true,
});
const USUARIOS = [
  {
    usuarioId: "u-yo",
    nombre: "Dora Dueña",
    correo: "d@e.test",
    rol: "dueno",
    activo: true,
    esYo: true,
  },
  {
    usuarioId: "u-con",
    nombre: "Carlos Contador",
    correo: "c@e.test",
    rol: "contador",
    activo: true,
    esYo: false,
  },
  {
    usuarioId: "u-off",
    nombre: "Olga Desactivada",
    correo: "o@e.test",
    rol: "asistente",
    activo: false,
    esYo: false,
  },
];
const PERMISOS_VER = ["clientes.ver", "usuarios.ver"];

function rutas(permisos: string[], extra: Record<string, Manejador> = {}) {
  return {
    ...rutaSesion(),
    "GET /api/acceso/yo": {
      status: 200,
      cuerpo: yoDe("dueno", permisos),
    },
    "GET /api/clientes": { status: 200, cuerpo: ACTIVOS },
    "GET /api/usuarios": { status: 200, cuerpo: USUARIOS },
    ...extra,
  };
}

const consulta = (f: FetchFalso) =>
  f
    .de("GET /api/clientes")
    .map((l) => Object.fromEntries(new URL(l.url, "http://x").searchParams));
const ultima = (f: FetchFalso) => consulta(f).at(-1);

describe("/clientes · filtros y acciones (007a)", () => {
  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    reiniciarSesion();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("la primera carga va sin parámetros y la fila muestra el estado de ambas credenciales", async () => {
    const f = instalarFetchFalso(rutas(PERMISOS_VER));
    render(<Clientes />);
    const alfa = await esperarFila("Alfa SAC");
    expect(consulta(f)[0]).toEqual({});
    expect(alfa.textContent).toContain("SOL: Verificada");
    expect(alfa.textContent).toContain("SIRE API: No configurada");
    const beta = await esperarFila("Beta SRL");
    expect(beta.textContent).toContain("SOL: Inválida");
    expect(beta.textContent).toContain("SIRE API: Configurada");
  });

  it("filtro Responsable: opciones Todos, ninguno y miembros activos; envía responsable=", async () => {
    const f = instalarFetchFalso(rutas(PERMISOS_VER));
    render(<Clientes />);
    await esperarFila("Alfa SAC");
    const select = await screen.findByLabelText("Responsable");
    await vi.waitFor(() =>
      expect(
        within(select)
          .getAllByRole("option")
          .map((o) => (o as HTMLOptionElement).value),
      ).toEqual(["", "ninguno", "u-yo", "u-con"]),
    );
    const user = userEvent.setup();
    await user.selectOptions(select, "ninguno");
    await vi.waitFor(() =>
      expect(ultima(f)).toEqual({ responsable: "ninguno" }),
    );
    await user.selectOptions(select, "u-con");
    await vi.waitFor(() => expect(ultima(f)).toEqual({ responsable: "u-con" }));
    await user.selectOptions(select, "");
    await vi.waitFor(() => expect(ultima(f)).toEqual({}));
  });

  it("filtro Credencial envía credencial= con el estado elegido", async () => {
    const f = instalarFetchFalso(rutas(PERMISOS_VER));
    render(<Clientes />);
    await esperarFila("Alfa SAC");
    const select = await screen.findByLabelText("Credencial");
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => (o as HTMLOptionElement).value),
    ).toEqual(["", "no_configurada", "configurada", "verificada", "invalida"]);
    const user = userEvent.setup();
    await user.selectOptions(select, "no_configurada");
    await vi.waitFor(() =>
      expect(ultima(f)).toEqual({ credencial: "no_configurada" }),
    );
  });

  it("'Mostrar archivados' envía archivados=1, muestra el texto Archivado y al desmarcar lo quita", async () => {
    const f = instalarFetchFalso(
      rutas(PERMISOS_VER, {
        "GET /api/clientes": (l) => ({
          status: 200,
          cuerpo: l.url.includes("archivados=1")
            ? [...ACTIVOS, ARCHIVADO]
            : ACTIVOS,
        }),
      }),
    );
    render(<Clientes />);
    await esperarFila("Alfa SAC");
    expect(screen.queryByText("Zeta EIRL")).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Mostrar archivados"));
    const zeta = await esperarFila("Zeta EIRL");
    expect(ultima(f)).toEqual({ archivados: "1" });
    expect(within(zeta).getByText("Archivado")).toBeTruthy();
    await user.click(screen.getByLabelText("Mostrar archivados"));
    await vi.waitFor(() => expect(ultima(f)).toEqual({}));
  });

  it("'Buscar' envía q recortado y los filtros se combinan (AND) sin parámetros vacíos", async () => {
    const f = instalarFetchFalso(rutas(PERMISOS_VER));
    render(<Clientes />);
    await esperarFila("Alfa SAC");
    const user = userEvent.setup();
    await user.selectOptions(
      await screen.findByLabelText("Credencial"),
      "invalida",
    );
    await user.click(screen.getByLabelText("Mostrar archivados"));
    await user.type(
      screen.getByRole("textbox", { name: "Buscar" }),
      "  50%_o'  ",
    );
    await vi.waitFor(
      () =>
        expect(ultima(f)).toEqual({
          credencial: "invalida",
          archivados: "1",
          q: "50%_o'",
        }),
      { timeout: 3000 },
    );
    // Texto en blanco: no se envía q.
    await user.clear(screen.getByRole("textbox", { name: "Buscar" }));
    await vi.waitFor(
      () =>
        expect(ultima(f)).toEqual({ credencial: "invalida", archivados: "1" }),
      { timeout: 3000 },
    );
  });

  it("sin `usuarios.ver` no se pide /api/usuarios y el filtro solo ofrece Todos y ninguno", async () => {
    const f = instalarFetchFalso(rutas(["clientes.ver"]));
    render(<Clientes />);
    await esperarFila("Alfa SAC");
    const select = await screen.findByLabelText("Responsable");
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => (o as HTMLOptionElement).value),
    ).toEqual(["", "ninguno"]);
    await asentar();
    expect(f.de("GET /api/usuarios")).toHaveLength(0);
  });

  it("'Nuevo cliente' (enlace a /clientes/nuevo) solo con clientes.crear", async () => {
    instalarFetchFalso(rutas(["clientes.ver", "clientes.crear"]));
    render(<Clientes />);
    await esperarFila("Alfa SAC");
    const enlace = await screen.findByRole("link", { name: "Nuevo cliente" });
    expect(enlace.getAttribute("href")).toBe("/clientes/nuevo");
    cleanup();

    instalarFetchFalso(
      rutas(["clientes.ver", "clientes.editar", "clientes.archivar"]),
    );
    render(<Clientes />);
    await esperarFila("Alfa SAC");
    await asentar();
    expect(screen.queryByRole("link", { name: "Nuevo cliente" })).toBeNull();
  });

  it("'Archivar' por fila activa y 'Reactivar' por fila archivada solo con clientes.archivar", async () => {
    instalarFetchFalso(
      rutas(["clientes.ver", "clientes.archivar"], {
        "GET /api/clientes": { status: 200, cuerpo: [...ACTIVOS, ARCHIVADO] },
      }),
    );
    render(<Clientes />);
    const alfa = await esperarFila("Alfa SAC");
    const zeta = await esperarFila("Zeta EIRL");
    expect(
      within(alfa).getByRole("link", { name: "Archivar" }).getAttribute("href"),
    ).toBe("/clientes/c-1");
    expect(within(alfa).queryByRole("link", { name: "Reactivar" })).toBeNull();
    expect(
      within(zeta)
        .getByRole("link", { name: "Reactivar" })
        .getAttribute("href"),
    ).toBe("/clientes/c-9");
    expect(within(zeta).queryByRole("link", { name: "Archivar" })).toBeNull();
    cleanup();

    instalarFetchFalso(
      rutas(["clientes.ver", "clientes.editar", "clientes.crear"], {
        "GET /api/clientes": { status: 200, cuerpo: [...ACTIVOS, ARCHIVADO] },
      }),
    );
    render(<Clientes />);
    await esperarFila("Zeta EIRL");
    await asentar();
    expect(screen.queryByRole("link", { name: "Archivar" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Reactivar" })).toBeNull();
  });
});

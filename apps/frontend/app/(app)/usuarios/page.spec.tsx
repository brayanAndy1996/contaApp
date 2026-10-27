import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../../lib/sesion";
import {
  ETIQUETA_ROL,
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
  type RespuestaSimulada,
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
  usePathname: () => "/usuarios",
  useSearchParams: () => new URLSearchParams(),
}));

import Usuarios from "./page";

// Contrato (plan 005, Frontend; CA-15, CA-4, CA-9, CA-10, RNF-007). Pantalla /usuarios:
// - Al montar: GET /api/acceso/yo; con `usuarios.ver` además GET /api/usuarios y GET /api/invitaciones.
//   Sin `usuarios.ver` muestra MENSAJES_ACCESO.sinPermiso y no pide nada más.
// - Tabla de miembros (role=row): una fila por miembro con celdas de texto: el rol (ETIQUETA_ROL) y
//   el estado "Activo" | "Desactivado", más nombre y correo.
// - Con `usuarios.gestionar`, en filas ajenas (no `esYo`): activo → select "Cambiar rol" (value = rol
//   actual; al elegir otro: PATCH /api/usuarios/:id/rol {rol}) y botón "Desactivar"
//   (POST /api/usuarios/:id/desactivar); desactivado → solo "Reactivar" (POST .../reactivar). Sin
//   confirmación intermedia. Las opciones de rol son las que el actor puede otorgar (D8): un
//   Administrador no ve "dueno". Un Administrador no ve ninguna acción sobre un Dueño.
// - Tabla de invitaciones (GET /api/invitaciones): celdas con correo, rol y estado "Pendiente" |
//   "Vencida"; con `usuarios.gestionar`, botones "Reenviar" (POST /api/invitaciones/:id/reenviar) y
//   "Revocar" (POST .../revocar), salvo invitaciones de rol `dueno` si el actor no es Dueño.
// - Formulario con `usuarios.gestionar`: campo "Correo", select "Rol", botón "Invitar" →
//   POST /api/invitaciones {correo, rol}; 201 → MENSAJES_ACCESO.invitacionEnviada, vacía "Correo" y
//   recarga invitaciones.
// - Tras cada acción exitosa recarga GET /api/usuarios (y /invitaciones si cambió).
// - Errores (role=alert): 403 → sinPermiso; 404 → noEncontrado; 409 ultimo_dueno → ultimoDueno;
//   409 ya_es_miembro / invitacion_existente / cupo_usuarios → su mensaje; otro → errorGeneral.

const YO = "dora@estudio.test";
const USUARIOS = [
  {
    usuarioId: "u-yo",
    nombre: "Dora Dueña",
    correo: YO,
    rol: "dueno",
    activo: true,
    esYo: true,
  },
  {
    usuarioId: "u-adm",
    nombre: "Adela Admin",
    correo: "adela@estudio.test",
    rol: "admin",
    activo: true,
    esYo: false,
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
    usuarioId: "u-ase",
    nombre: "Asia Asistente",
    correo: "asia@estudio.test",
    rol: "asistente",
    activo: false,
    esYo: false,
  },
  {
    usuarioId: "u-due",
    nombre: "Dario Dueño",
    correo: "dario@estudio.test",
    rol: "dueno",
    activo: true,
    esYo: false,
  },
];
const INVITADOR = { usuarioId: "u-yo", nombre: "Dora Dueña" };
const INVITACIONES = [
  {
    id: "i-1",
    correo: "nuevo@estudio.test",
    rol: "contador",
    invitadoPor: INVITADOR,
    creadaEn: "2026-10-25T10:00:00.000Z",
    venceEn: "2026-10-28T10:00:00.000Z",
    vencida: false,
  },
  {
    id: "i-2",
    correo: "vencida@estudio.test",
    rol: "lectura",
    invitadoPor: INVITADOR,
    creadaEn: "2026-10-01T10:00:00.000Z",
    venceEn: "2026-10-04T10:00:00.000Z",
    vencida: true,
  },
  {
    id: "i-3",
    correo: "futuro-dueno@estudio.test",
    rol: "dueno",
    invitadoPor: INVITADOR,
    creadaEn: "2026-10-25T10:00:00.000Z",
    venceEn: "2026-10-28T10:00:00.000Z",
    vencida: false,
  },
];

function rutas(
  rol: RolPrueba,
  extra: Record<string, Manejador> = {},
  permisos?: string[],
): Record<string, Manejador> {
  return {
    ...rutaSesion(),
    "GET /api/acceso/yo": { status: 200, cuerpo: yoDe(rol, permisos) },
    "GET /api/usuarios": { status: 200, cuerpo: USUARIOS },
    "GET /api/invitaciones": { status: 200, cuerpo: INVITACIONES },
    ...extra,
  };
}

const quitar = (fila: HTMLElement, nombre: string) =>
  within(fila).queryByRole("button", { name: nombre });

describe("/usuarios", () => {
  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    reiniciarSesion();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("lista a cada miembro con su rol y su estado (Activo / Desactivado)", async () => {
    instalarFetchFalso(rutas("dueno"));
    render(<Usuarios />);
    for (const u of USUARIOS) {
      const fila = await esperarFila(u.correo);
      const textos = celdas(fila);
      expect(textos, u.correo).toContain(ETIQUETA_ROL[u.rol as RolPrueba]);
      expect(textos, u.correo).toContain(u.activo ? "Activo" : "Desactivado");
      expect(fila.textContent).toContain(u.nombre);
    }
  });

  it("Dueño: filas ajenas activas con 'Cambiar rol' (5 roles) y Desactivar; la desactivada solo con Reactivar; la propia sin acciones", async () => {
    instalarFetchFalso(rutas("dueno"));
    render(<Usuarios />);
    const carlos = await esperarFila("carlos@estudio.test");
    const selector = within(carlos).getByRole("combobox", {
      name: "Cambiar rol",
    }) as HTMLSelectElement;
    expect(selector.value).toBe("contador");
    expect([...selector.options].map((o) => o.value).sort()).toEqual(
      ["admin", "asistente", "contador", "dueno", "lectura"].sort(),
    );
    expect(quitar(carlos, "Desactivar")).toBeTruthy();
    expect(quitar(carlos, "Reactivar")).toBeNull();

    const asia = await esperarFila("asia@estudio.test");
    expect(quitar(asia, "Reactivar")).toBeTruthy();
    expect(quitar(asia, "Desactivar")).toBeNull();
    expect(within(asia).queryByRole("combobox")).toBeNull();

    const dario = await esperarFila("dario@estudio.test");
    expect(quitar(dario, "Desactivar")).toBeTruthy();

    const propia = await esperarFila(YO);
    expect(within(propia).queryAllByRole("button")).toHaveLength(0);
    expect(within(propia).queryByRole("combobox")).toBeNull();
  });

  it("Administrador: ninguna acción sobre Dueños, y no puede otorgar el rol Dueño", async () => {
    instalarFetchFalso(rutas("admin"));
    render(<Usuarios />);
    const dario = await esperarFila("dario@estudio.test");
    expect(within(dario).queryAllByRole("button")).toHaveLength(0);
    expect(within(dario).queryByRole("combobox")).toBeNull();

    const carlos = await esperarFila("carlos@estudio.test");
    const selector = within(carlos).getByRole("combobox", {
      name: "Cambiar rol",
    }) as HTMLSelectElement;
    expect([...selector.options].map((o) => o.value)).not.toContain("dueno");
    expect(quitar(carlos, "Desactivar")).toBeTruthy();

    const futuro = await esperarFila("futuro-dueno@estudio.test");
    expect(quitar(futuro, "Reenviar")).toBeNull();
    expect(quitar(futuro, "Revocar")).toBeNull();
    const nueva = await esperarFila("nuevo@estudio.test");
    expect(quitar(nueva, "Reenviar")).toBeTruthy();

    const rol = screen.getByLabelText("Rol") as HTMLSelectElement;
    expect([...rol.options].map((o) => o.value)).not.toContain("dueno");
  });

  it("Dueño: el formulario de invitar ofrece los 5 roles", async () => {
    instalarFetchFalso(rutas("dueno"));
    render(<Usuarios />);
    await esperarFila("carlos@estudio.test");
    const rol = screen.getByLabelText("Rol") as HTMLSelectElement;
    expect([...rol.options].map((o) => o.value).sort()).toEqual(
      ["admin", "asistente", "contador", "dueno", "lectura"].sort(),
    );
  });

  it("lista invitaciones con rol y estado Pendiente / Vencida, y Reenviar y Revocar para el Dueño", async () => {
    instalarFetchFalso(rutas("dueno"));
    render(<Usuarios />);
    const pendiente = await esperarFila("nuevo@estudio.test");
    expect(celdas(pendiente)).toContain("Contador");
    expect(celdas(pendiente)).toContain("Pendiente");
    expect(quitar(pendiente, "Reenviar")).toBeTruthy();
    expect(quitar(pendiente, "Revocar")).toBeTruthy();
    const vencida = await esperarFila("vencida@estudio.test");
    expect(celdas(vencida)).toContain("Lectura");
    expect(celdas(vencida)).toContain("Vencida");
    const futuro = await esperarFila("futuro-dueno@estudio.test");
    expect(quitar(futuro, "Revocar")).toBeTruthy();
  });

  it("solo con usuarios.ver (sin gestionar): lista todo y no muestra ninguna acción ni el formulario", async () => {
    instalarFetchFalso(rutas("admin", {}, ["usuarios.ver"]));
    render(<Usuarios />);
    await esperarFila("carlos@estudio.test");
    await esperarFila("nuevo@estudio.test");
    await asentar();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByLabelText("Correo")).toBeNull();
  });

  it("sin usuarios.ver (Contador): mensaje de permiso y no pide miembros ni invitaciones", async () => {
    const f = instalarFetchFalso(rutas("contador"));
    render(<Usuarios />);
    expect(await screen.findByText(MENSAJES_ACCESO.sinPermiso)).toBeTruthy();
    await asentar();
    expect(f.de("GET /api/usuarios")).toHaveLength(0);
    expect(f.de("GET /api/invitaciones")).toHaveLength(0);
    expect(screen.queryAllByRole("row")).toHaveLength(0);
  });

  it("invitar: POST /api/invitaciones {correo, rol} con X-CSRF-Token; mensaje, campo vacío y recarga", async () => {
    const f = instalarFetchFalso(
      rutas("dueno", {
        "POST /api/invitaciones": { status: 201, cuerpo: INVITACIONES[0] },
      }),
    );
    render(<Usuarios />);
    await esperarFila("carlos@estudio.test");
    const user = userEvent.setup();
    const correo = screen.getByLabelText("Correo") as HTMLInputElement;
    await user.type(correo, "otra@estudio.test");
    await user.selectOptions(screen.getByLabelText("Rol"), "asistente");
    await user.click(screen.getByRole("button", { name: "Invitar" }));
    await screen.findByText(MENSAJES_ACCESO.invitacionEnviada);
    const [llamada] = f.de("POST /api/invitaciones");
    expect(llamada?.body).toEqual({
      correo: "otra@estudio.test",
      rol: "asistente",
    });
    expect(llamada?.headers["x-csrf-token"]).toBe("csrf-acceso-1");
    expect(correo.value).toBe("");
    await vi.waitFor(() =>
      expect(f.de("GET /api/invitaciones")).toHaveLength(2),
    );
  });

  it.each([
    ["ya_es_miembro", MENSAJES_ACCESO.yaEsMiembro],
    ["invitacion_existente", MENSAJES_ACCESO.invitacionExistente],
    ["cupo_usuarios", MENSAJES_ACCESO.cupoUsuarios],
  ])("invitar: 409 %s → su mensaje", async (codigo, mensaje) => {
    instalarFetchFalso(
      rutas("dueno", {
        "POST /api/invitaciones": { status: 409, cuerpo: { codigo } },
      }),
    );
    render(<Usuarios />);
    await esperarFila("carlos@estudio.test");
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Correo"), "otra@estudio.test");
    await user.click(screen.getByRole("button", { name: "Invitar" }));
    expect(await screen.findByText(mensaje)).toBeTruthy();
  });

  it("invitar: 403 → mensaje genérico de permiso, sin detalles del servidor", async () => {
    instalarFetchFalso(
      rutas("dueno", {
        "POST /api/invitaciones": {
          status: 403,
          cuerpo: { codigo: "permiso_denegado" },
        },
      }),
    );
    const { container } = render(<Usuarios />);
    await esperarFila("carlos@estudio.test");
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Correo"), "otra@estudio.test");
    await user.click(screen.getByRole("button", { name: "Invitar" }));
    expect(await screen.findByText(MENSAJES_ACCESO.sinPermiso)).toBeTruthy();
    expect(container.textContent).not.toContain("permiso_denegado");
  });

  it("cambiar rol: PATCH /api/usuarios/:id/rol {rol} y recarga la lista", async () => {
    const f = instalarFetchFalso(
      rutas("dueno", {
        "PATCH /api/usuarios/u-con/rol": {
          status: 200,
          cuerpo: { ...USUARIOS[2], rol: "asistente" },
        },
        "GET /api/usuarios": (_l, vez) => ({
          status: 200,
          cuerpo:
            vez === 1
              ? USUARIOS
              : USUARIOS.map((u) =>
                  u.usuarioId === "u-con" ? { ...u, rol: "asistente" } : u,
                ),
        }),
      }),
    );
    render(<Usuarios />);
    const carlos = await esperarFila("carlos@estudio.test");
    const user = userEvent.setup();
    await user.selectOptions(
      within(carlos).getByRole("combobox", { name: "Cambiar rol" }),
      "asistente",
    );
    await vi.waitFor(() =>
      expect(f.de("PATCH /api/usuarios/u-con/rol")).toHaveLength(1),
    );
    const [llamada] = f.de("PATCH /api/usuarios/u-con/rol");
    expect(llamada?.body).toEqual({ rol: "asistente" });
    expect(llamada?.headers["x-csrf-token"]).toBe("csrf-acceso-1");
    await vi.waitFor(() =>
      expect(
        celdas(
          screen
            .getAllByRole("row")
            .find((r) => r.textContent?.includes("carlos@estudio.test"))!,
        ),
      ).toContain("Asistente"),
    );
    expect(f.de("GET /api/usuarios")).toHaveLength(2);
  });

  it("desactivar: POST /api/usuarios/:id/desactivar sin confirmación y recarga", async () => {
    const f = instalarFetchFalso(
      rutas("dueno", {
        "POST /api/usuarios/u-con/desactivar": {
          status: 200,
          cuerpo: { ...USUARIOS[2], activo: false },
        },
      }),
    );
    render(<Usuarios />);
    const carlos = await esperarFila("carlos@estudio.test");
    const user = userEvent.setup();
    await user.click(
      within(carlos).getByRole("button", { name: "Desactivar" }),
    );
    await vi.waitFor(() =>
      expect(f.de("POST /api/usuarios/u-con/desactivar")).toHaveLength(1),
    );
    const [llamada] = f.de("POST /api/usuarios/u-con/desactivar");
    expect(llamada?.headers["x-csrf-token"]).toBe("csrf-acceso-1");
    await vi.waitFor(() => expect(f.de("GET /api/usuarios")).toHaveLength(2));
  });

  it("reactivar: POST /api/usuarios/:id/reactivar y recarga; 409 cupo_usuarios muestra su mensaje", async () => {
    const f = instalarFetchFalso(
      rutas("dueno", {
        "POST /api/usuarios/u-ase/reactivar": (_l, vez) =>
          vez === 1
            ? { status: 409, cuerpo: { codigo: "cupo_usuarios" } }
            : { status: 200, cuerpo: { ...USUARIOS[3], activo: true } },
      }),
    );
    render(<Usuarios />);
    const asia = await esperarFila("asia@estudio.test");
    const user = userEvent.setup();
    await user.click(within(asia).getByRole("button", { name: "Reactivar" }));
    expect(await screen.findByText(MENSAJES_ACCESO.cupoUsuarios)).toBeTruthy();
    await user.click(
      within(await esperarFila("asia@estudio.test")).getByRole("button", {
        name: "Reactivar",
      }),
    );
    await vi.waitFor(() =>
      expect(f.de("POST /api/usuarios/u-ase/reactivar")).toHaveLength(2),
    );
    await vi.waitFor(() =>
      expect(f.de("GET /api/usuarios").length).toBeGreaterThan(1),
    );
  });

  it("desactivar al último Dueño: 409 ultimo_dueno → mensaje propio", async () => {
    instalarFetchFalso(
      rutas("dueno", {
        "POST /api/usuarios/u-due/desactivar": {
          status: 409,
          cuerpo: { codigo: "ultimo_dueno" },
        },
      }),
    );
    render(<Usuarios />);
    const dario = await esperarFila("dario@estudio.test");
    const user = userEvent.setup();
    await user.click(within(dario).getByRole("button", { name: "Desactivar" }));
    expect(await screen.findByText(MENSAJES_ACCESO.ultimoDueno)).toBeTruthy();
  });

  it("404 y 403 de una acción muestran mensajes genéricos", async () => {
    instalarFetchFalso(
      rutas("dueno", {
        "POST /api/usuarios/u-con/desactivar": (_l, vez) =>
          vez === 1
            ? { status: 404, cuerpo: { codigo: "no_encontrado" } }
            : { status: 403, cuerpo: { codigo: "permiso_denegado" } },
      }),
    );
    const { container } = render(<Usuarios />);
    const user = userEvent.setup();
    const desactivar = async () =>
      user.click(
        within(await esperarFila("carlos@estudio.test")).getByRole("button", {
          name: "Desactivar",
        }),
      );
    await desactivar();
    expect(await screen.findByText(MENSAJES_ACCESO.noEncontrado)).toBeTruthy();
    await desactivar();
    expect(await screen.findByText(MENSAJES_ACCESO.sinPermiso)).toBeTruthy();
    expect(container.textContent).not.toContain("no_encontrado");
    expect(container.textContent).not.toContain("permiso_denegado");
  });

  it("reenviar: POST /api/invitaciones/:id/reenviar; revocar: POST .../revocar; ambos recargan invitaciones", async () => {
    const f = instalarFetchFalso(
      rutas("dueno", {
        "POST /api/invitaciones/i-1/reenviar": {
          status: 200,
          cuerpo: INVITACIONES[0],
        },
        "POST /api/invitaciones/i-1/revocar": { status: 204 },
      }),
    );
    render(<Usuarios />);
    const fila = await esperarFila("nuevo@estudio.test");
    const user = userEvent.setup();
    await user.click(within(fila).getByRole("button", { name: "Reenviar" }));
    await vi.waitFor(() =>
      expect(f.de("POST /api/invitaciones/i-1/reenviar")).toHaveLength(1),
    );
    await vi.waitFor(() =>
      expect(f.de("GET /api/invitaciones")).toHaveLength(2),
    );
    await user.click(
      within(await esperarFila("nuevo@estudio.test")).getByRole("button", {
        name: "Revocar",
      }),
    );
    await vi.waitFor(() =>
      expect(f.de("POST /api/invitaciones/i-1/revocar")).toHaveLength(1),
    );
    await vi.waitFor(() =>
      expect(f.de("GET /api/invitaciones")).toHaveLength(3),
    );
    const [reenvio] = f.de("POST /api/invitaciones/i-1/reenviar");
    expect(reenvio?.headers["x-csrf-token"]).toBe("csrf-acceso-1");
  });

  it("nunca muestra tokens ni hashes de invitación", async () => {
    const respuesta: RespuestaSimulada = {
      status: 200,
      cuerpo: INVITACIONES.map((i) => ({
        ...i,
        token: "TokenCanarioQueNuncaDebeVerse",
        tokenHash: "HashCanarioQueNuncaDebeVerse",
      })),
    };
    instalarFetchFalso(rutas("dueno", { "GET /api/invitaciones": respuesta }));
    const { container } = render(<Usuarios />);
    await esperarFila("nuevo@estudio.test");
    expect(container.innerHTML).not.toContain("CanarioQueNuncaDebeVerse");
  });
});

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
} from "../../../pruebas/acceso";
import {
  ID_AUDITOR,
  ID_PRACTICANTE,
  MENSAJES_ROLES,
} from "../../../pruebas/roles";
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
  usePathname: () => "/usuarios",
  useSearchParams: () => new URLSearchParams(),
}));

import Usuarios from "./page";

// Contrato (plan 030, Contratos HTTP; spec Alcance, U2, CA-1, CA-3, CA-5). Se suma a page.spec.tsx de
// 005 (no lo reemplaza). Selector de rol en /usuarios (T10):
// - Con `usuarios.gestionar` pide también GET /api/roles/asignables →
//   `{sistema: Rol[], propios: [{id, nombre}]}` (lo que el actor puede asignar, por `puedeGestionar`);
//   sin `usuarios.gestionar` no lo pide. Las opciones del select "Rol" (invitar) y de "Cambiar rol"
//   salen de esa respuesta: sistema con ETIQUETA_ROL (value = rol) y propios con su nombre (value = id).
// - Si GET /api/roles/asignables falla, vuelve al comportamiento de 005 (opciones de sistema por
//   `puedeOtorgar`) sin mostrar alerta.
// - Invitar con rol propio: POST /api/invitaciones {correo, rol: {rolId}} (la unión `RolAsignado`);
//   cambiar rol: PATCH /api/usuarios/:id/rol {rol: {rolId}}. Con rol de sistema el cuerpo no cambia.
// - Miembros e invitaciones con `rol: "propio"` traen `rolPropio: {id, nombre}`: la celda del rol
//   muestra el nombre y el select "Cambiar rol" queda con value = id.
// - Un miembro cuyo rol propio no está entre los asignables del actor (U2) no muestra acciones.
// - 404 (rol borrado o ajeno) → noEncontrado; 403 `escalada` → MENSAJES_ROLES.escalada; sin mostrar el
//   código.

const PRACTICANTE_REF = { id: ID_PRACTICANTE, nombre: "Practicante" };
const AUDITOR_REF = { id: ID_AUDITOR, nombre: "Auditor" };

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
    usuarioId: "u-pra",
    nombre: "Paula Practicante",
    correo: "paula@estudio.test",
    rol: "propio",
    rolPropio: PRACTICANTE_REF,
    activo: true,
    esYo: false,
  },
  {
    usuarioId: "u-aud",
    nombre: "Aldo Auditor",
    correo: "aldo@estudio.test",
    rol: "propio",
    rolPropio: AUDITOR_REF,
    activo: true,
    esYo: false,
  },
];

const INVITACIONES = [
  {
    id: "i-1",
    correo: "pasante@estudio.test",
    rol: "propio",
    rolPropio: PRACTICANTE_REF,
    invitadoPor: { usuarioId: "u-yo", nombre: "Dora Dueña" },
    creadaEn: "2026-10-25T10:00:00.000Z",
    venceEn: "2026-10-28T10:00:00.000Z",
    vencida: false,
  },
];

const ASIGNABLES_DUENO = {
  sistema: ["dueno", "admin", "contador", "asistente", "lectura"],
  propios: [PRACTICANTE_REF, AUDITOR_REF],
};
// Un actor limitado (U2): ni Dueño ni Administrador, y solo el rol propio Practicante.
const ASIGNABLES_LIMITADO = {
  sistema: ["contador", "asistente", "lectura"],
  propios: [PRACTICANTE_REF],
};

function rutas(
  extra: Record<string, Manejador> = {},
  asignables: Record<string, unknown> | Manejador = ASIGNABLES_DUENO,
  permisos?: string[],
): Record<string, Manejador> {
  return {
    ...rutaSesion(),
    "GET /api/acceso/yo": { status: 200, cuerpo: yoDe("dueno", permisos) },
    "GET /api/usuarios": { status: 200, cuerpo: USUARIOS },
    "GET /api/invitaciones": { status: 200, cuerpo: INVITACIONES },
    "GET /api/roles/asignables":
      "status" in asignables
        ? (asignables as Manejador)
        : { status: 200, cuerpo: asignables },
    ...extra,
  };
}

const valores = (s: HTMLSelectElement) => [...s.options].map((o) => o.value);
const etiquetas = (s: HTMLSelectElement) =>
  [...s.options].map((o) => o.textContent);

describe("/usuarios · selector de rol con roles propios", () => {
  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    reiniciarSesion();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("con usuarios.gestionar pide GET /api/roles/asignables; sin gestionar no lo pide", async () => {
    const f = instalarFetchFalso(rutas());
    render(<Usuarios />);
    await esperarFila("carlos@estudio.test");
    await vi.waitFor(() =>
      expect(f.de("GET /api/roles/asignables")).toHaveLength(1),
    );
    expect(f.de("GET /api/roles/asignables")[0]?.headers["x-estudio"]).toBe(
      "e-a",
    );
    cleanup();
    reiniciarSesion();
    const g = instalarFetchFalso(rutas({}, ASIGNABLES_DUENO, ["usuarios.ver"]));
    render(<Usuarios />);
    await esperarFila("carlos@estudio.test");
    await asentar();
    expect(g.de("GET /api/roles/asignables")).toHaveLength(0);
  });

  it("invitar: el select Rol ofrece los asignables, con los propios por nombre y su id como value", async () => {
    instalarFetchFalso(rutas());
    render(<Usuarios />);
    await esperarFila("carlos@estudio.test");
    const rol = (await vi.waitFor(() => {
      const s = screen.getByLabelText("Rol") as HTMLSelectElement;
      if (!valores(s).includes(ID_PRACTICANTE)) throw new Error("sin propios");
      return s;
    })) as HTMLSelectElement;
    expect(valores(rol).sort()).toEqual(
      [
        "admin",
        "asistente",
        "contador",
        "dueno",
        "lectura",
        ID_AUDITOR,
        ID_PRACTICANTE,
      ].sort(),
    );
    expect(etiquetas(rol)).toContain("Practicante");
    expect(etiquetas(rol)).toContain("Auditor");
    expect(etiquetas(rol)).toContain(ETIQUETA_ROL.contador);
  });

  it("un actor limitado solo ve los roles que puede asignar (sin Dueño, Administrador ni otros propios)", async () => {
    instalarFetchFalso(rutas({}, ASIGNABLES_LIMITADO));
    render(<Usuarios />);
    await esperarFila("carlos@estudio.test");
    await vi.waitFor(() => {
      const s = screen.getByLabelText("Rol") as HTMLSelectElement;
      if (!valores(s).includes(ID_PRACTICANTE)) throw new Error("sin propios");
    });
    const rol = screen.getByLabelText("Rol") as HTMLSelectElement;
    expect(valores(rol).sort()).toEqual(
      ["asistente", "contador", "lectura", ID_PRACTICANTE].sort(),
    );
    const carlos = await esperarFila("carlos@estudio.test");
    const cambiar = within(carlos).getByRole("combobox", {
      name: "Cambiar rol",
    }) as HTMLSelectElement;
    expect(valores(cambiar)).not.toContain("dueno");
    expect(valores(cambiar)).not.toContain(ID_AUDITOR);
    expect(valores(cambiar)).toContain(ID_PRACTICANTE);
  });

  it("invitar con un rol propio: POST /api/invitaciones {correo, rol: {rolId}} con X-CSRF-Token", async () => {
    const f = instalarFetchFalso(
      rutas({
        "POST /api/invitaciones": { status: 201, cuerpo: INVITACIONES[0] },
      }),
    );
    render(<Usuarios />);
    await esperarFila("carlos@estudio.test");
    await vi.waitFor(() => {
      const s = screen.getByLabelText("Rol") as HTMLSelectElement;
      if (!valores(s).includes(ID_PRACTICANTE)) throw new Error("sin propios");
    });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Correo"), "otra@estudio.test");
    await user.selectOptions(screen.getByLabelText("Rol"), "Practicante");
    await user.click(screen.getByRole("button", { name: "Invitar" }));
    await screen.findByText(MENSAJES_ACCESO.invitacionEnviada);
    const [llamada] = f.de("POST /api/invitaciones");
    expect(llamada?.body).toEqual({
      correo: "otra@estudio.test",
      rol: { rolId: ID_PRACTICANTE },
    });
    expect(llamada?.headers["x-csrf-token"]).toBe("csrf-acceso-1");
  });

  it("invitar con un rol de sistema conserva el cuerpo de 005 {correo, rol}", async () => {
    const f = instalarFetchFalso(
      rutas({
        "POST /api/invitaciones": { status: 201, cuerpo: INVITACIONES[0] },
      }),
    );
    render(<Usuarios />);
    await esperarFila("carlos@estudio.test");
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Correo"), "otra@estudio.test");
    await user.selectOptions(screen.getByLabelText("Rol"), "asistente");
    await user.click(screen.getByRole("button", { name: "Invitar" }));
    await screen.findByText(MENSAJES_ACCESO.invitacionEnviada);
    expect(f.de("POST /api/invitaciones")[0]?.body).toEqual({
      correo: "otra@estudio.test",
      rol: "asistente",
    });
  });

  it("cambiar rol a uno propio: PATCH /api/usuarios/:id/rol {rol: {rolId}} y recarga", async () => {
    const f = instalarFetchFalso(
      rutas({
        "PATCH /api/usuarios/u-con/rol": {
          status: 200,
          cuerpo: USUARIOS[1],
        },
      }),
    );
    render(<Usuarios />);
    const carlos = await esperarFila("carlos@estudio.test");
    const selector = within(carlos).getByRole("combobox", {
      name: "Cambiar rol",
    }) as HTMLSelectElement;
    await vi.waitFor(() => expect(valores(selector)).toContain(ID_PRACTICANTE));
    const user = userEvent.setup();
    await user.selectOptions(selector, "Practicante");
    await vi.waitFor(() =>
      expect(f.de("PATCH /api/usuarios/u-con/rol")).toHaveLength(1),
    );
    const [llamada] = f.de("PATCH /api/usuarios/u-con/rol");
    expect(llamada?.body).toEqual({ rol: { rolId: ID_PRACTICANTE } });
    expect(llamada?.headers["x-csrf-token"]).toBe("csrf-acceso-1");
    await vi.waitFor(() => expect(f.de("GET /api/usuarios")).toHaveLength(2));
  });

  it("un miembro con rol propio muestra el nombre del rol y su select queda con value = id", async () => {
    instalarFetchFalso(rutas());
    render(<Usuarios />);
    const paula = await esperarFila("paula@estudio.test");
    expect(celdas(paula)).toContain("Practicante");
    const selector = within(paula).getByRole("combobox", {
      name: "Cambiar rol",
    }) as HTMLSelectElement;
    await vi.waitFor(() => expect(selector.value).toBe(ID_PRACTICANTE));
    expect(
      within(paula).getByRole("button", { name: "Desactivar" }),
    ).toBeTruthy();
  });

  it("una invitación con rol propio muestra el nombre del rol y sus acciones", async () => {
    instalarFetchFalso(rutas());
    render(<Usuarios />);
    const fila = await esperarFila("pasante@estudio.test");
    expect(celdas(fila)).toContain("Practicante");
    expect(celdas(fila)).toContain("Pendiente");
    expect(within(fila).getByRole("button", { name: "Revocar" })).toBeTruthy();
  });

  it("U2: un miembro cuyo rol propio el actor no puede asignar no muestra acciones", async () => {
    instalarFetchFalso(rutas({}, ASIGNABLES_LIMITADO));
    render(<Usuarios />);
    const aldo = await esperarFila("aldo@estudio.test");
    await vi.waitFor(() => {
      const s = screen.getByLabelText("Rol") as HTMLSelectElement;
      if (!valores(s).includes(ID_PRACTICANTE)) throw new Error("sin propios");
    });
    expect(celdas(aldo)).toContain("Auditor");
    expect(within(aldo).queryAllByRole("button")).toHaveLength(0);
    expect(within(aldo).queryByRole("combobox")).toBeNull();
    const paula = await esperarFila("paula@estudio.test");
    expect(
      within(paula).getByRole("combobox", { name: "Cambiar rol" }),
    ).toBeTruthy();
  });

  it("si GET /api/roles/asignables falla: opciones de sistema como en 005 y sin alerta", async () => {
    instalarFetchFalso(rutas({}, { status: 500, cuerpo: {} }));
    render(<Usuarios />);
    await esperarFila("carlos@estudio.test");
    await asentar();
    const rol = screen.getByLabelText("Rol") as HTMLSelectElement;
    expect(valores(rol).sort()).toEqual(
      ["admin", "asistente", "contador", "dueno", "lectura"].sort(),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("invitar: 404 (rol propio borrado o ajeno) → mensaje de no encontrado, sin código", async () => {
    instalarFetchFalso(
      rutas({
        "POST /api/invitaciones": {
          status: 404,
          cuerpo: { codigo: "no_encontrado" },
        },
      }),
    );
    const { container } = render(<Usuarios />);
    await esperarFila("carlos@estudio.test");
    await vi.waitFor(() => {
      const s = screen.getByLabelText("Rol") as HTMLSelectElement;
      if (!valores(s).includes(ID_PRACTICANTE)) throw new Error("sin propios");
    });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Correo"), "otra@estudio.test");
    await user.selectOptions(screen.getByLabelText("Rol"), "Practicante");
    await user.click(screen.getByRole("button", { name: "Invitar" }));
    expect(await screen.findByText(MENSAJES_ACCESO.noEncontrado)).toBeTruthy();
    expect(container.textContent).not.toContain("no_encontrado");
  });

  it("cambiar rol: 403 escalada → MENSAJES_ROLES.escalada, sin mostrar el código", async () => {
    instalarFetchFalso(
      rutas({
        "PATCH /api/usuarios/u-con/rol": {
          status: 403,
          cuerpo: { codigo: "escalada" },
        },
      }),
    );
    const { container } = render(<Usuarios />);
    const carlos = await esperarFila("carlos@estudio.test");
    const selector = within(carlos).getByRole("combobox", {
      name: "Cambiar rol",
    }) as HTMLSelectElement;
    await vi.waitFor(() => expect(valores(selector)).toContain(ID_AUDITOR));
    const user = userEvent.setup();
    await user.selectOptions(selector, "Auditor");
    expect(await screen.findByText(MENSAJES_ROLES.escalada)).toBeTruthy();
    expect(container.textContent).not.toContain('escalada"');
    expect(container.textContent).not.toContain("codigo");
  });
});

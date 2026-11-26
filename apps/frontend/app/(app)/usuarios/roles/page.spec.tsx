import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../../../lib/sesion";
import {
  ETIQUETA_ROL,
  MENSAJES_ACCESO,
  asentar,
  celdas,
  yoDe,
} from "../../../../pruebas/acceso";
import {
  AUDITOR,
  ID_AUDITOR,
  ID_PRACTICANTE,
  MENSAJES_ROLES,
  PERMISOS_ACTOR_TOTAL,
  PRACTICANTE,
  filaDe,
  rutasRoles,
  yoPropio,
} from "../../../../pruebas/roles";
import {
  crearRouterFalso,
  instalarFetchFalso,
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
  usePathname: () => "/usuarios/roles",
  useSearchParams: () => new URLSearchParams(),
}));

import Roles from "./page";

// Contrato (plan 030, Contratos HTTP; spec Alcance, U2, U5; CA-1, CA-3, CA-6, CA-9). Pantalla
// /usuarios/roles (T10 crea `roles/page.tsx`, export por defecto):
// - Al montar: GET /api/acceso/yo; con `roles.gestionar` además GET /api/roles → `{sistema, propios}`
//   (sistema: `{rol, alcance, permisos}`; propios: `{id, nombre, alcance, permisos, miembros,
//   invitaciones}`). Sin `roles.gestionar`: MENSAJES_ACCESO.sinPermiso y no pide /roles.
// - Tabla "Roles de sistema" (5 filas, celdas: ETIQUETA_ROL y alcance "Global" | "Asignado"), de solo
//   lectura: sin botones ni casillas (RF-021, CA-3).
// - Tabla "Roles propios": celdas con nombre, alcance, nº de miembros e invitaciones (texto exacto del
//   número); por fila, botones "Editar" y "Eliminar", salvo el rol que el actor tiene asignado
//   (`yo.rolPropio`, U2). Sin propios: MENSAJES_ROLES.sinPropios. Botón "Crear rol" siempre visible.
// - Eliminar (sin confirmación, como en 005): DELETE /api/roles/:id con X-CSRF-Token; 204 →
//   MENSAJES_ROLES.rolEliminado y recarga GET /api/roles. 409 `rol_en_uso` (conteos en la raíz del
//   cuerpo `{codigo, miembros, invitaciones}`) → MENSAJES_ROLES.enUso; 403 `rol_propio` → rolPropio;
//   404 → noEncontrado. Errores en role=alert, sin mostrar el `codigo`.

const YO_PRACTICANTE = yoPropio(
  PERMISOS_ACTOR_TOTAL.filter((p) => p !== "plan.gestionar"),
  "global",
  { id: ID_AUDITOR, nombre: "Auditor" },
);

describe("/usuarios/roles · lista", () => {
  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    reiniciarSesion();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sin roles.gestionar: mensaje de permiso y no pide /api/roles", async () => {
    const f = instalarFetchFalso(
      rutasRoles({}, yoDe("admin", ["usuarios.ver", "usuarios.gestionar"])),
    );
    render(<Roles />);
    expect(await screen.findByText(MENSAJES_ACCESO.sinPermiso)).toBeTruthy();
    await asentar();
    expect(f.de("GET /api/roles")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Crear rol" })).toBeNull();
  });

  it("roles de sistema: 5 filas con etiqueta y alcance, sin acciones (solo lectura)", async () => {
    instalarFetchFalso(rutasRoles());
    render(<Roles />);
    await screen.findByRole("table", { name: "Roles de sistema" });
    const tabla = screen.getByRole("table", { name: "Roles de sistema" });
    const esperadas: [string, string][] = [
      [ETIQUETA_ROL.dueno, "Global"],
      [ETIQUETA_ROL.admin, "Global"],
      [ETIQUETA_ROL.contador, "Asignado"],
      [ETIQUETA_ROL.asistente, "Asignado"],
      [ETIQUETA_ROL.lectura, "Asignado"],
    ];
    for (const [etiqueta, alcance] of esperadas) {
      const textos = celdas(filaDe("Roles de sistema", etiqueta));
      expect(textos, etiqueta).toContain(etiqueta);
      expect(textos, etiqueta).toContain(alcance);
    }
    expect(within(tabla).queryAllByRole("button")).toHaveLength(0);
    expect(within(tabla).queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("roles propios: nombre, alcance, miembros e invitaciones, con Editar y Eliminar por fila", async () => {
    instalarFetchFalso(rutasRoles());
    render(<Roles />);
    await screen.findByRole("table", { name: "Roles propios" });
    const practicante = filaDe("Roles propios", PRACTICANTE.nombre);
    const textos = celdas(practicante);
    expect(textos).toContain("Practicante");
    expect(textos).toContain("Asignado");
    expect(textos).toContain("2");
    expect(textos).toContain("1");
    expect(
      within(practicante).getByRole("button", { name: "Editar" }),
    ).toBeTruthy();
    expect(
      within(practicante).getByRole("button", { name: "Eliminar" }),
    ).toBeTruthy();
    const auditor = filaDe("Roles propios", AUDITOR.nombre);
    expect(celdas(auditor)).toContain("Global");
    expect(
      within(auditor).getByRole("button", { name: "Eliminar" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Crear rol" })).toBeTruthy();
  });

  it("sin roles propios: texto vacío y el botón Crear rol", async () => {
    instalarFetchFalso(rutasRoles({}, undefined, []));
    render(<Roles />);
    expect(await screen.findByText(MENSAJES_ROLES.sinPropios)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Crear rol" })).toBeTruthy();
  });

  it("el rol que el actor tiene asignado no ofrece Editar ni Eliminar (U2); los demás sí", async () => {
    instalarFetchFalso(rutasRoles({}, YO_PRACTICANTE));
    render(<Roles />);
    await screen.findByRole("table", { name: "Roles propios" });
    const propio = filaDe("Roles propios", AUDITOR.nombre);
    expect(within(propio).queryAllByRole("button")).toHaveLength(0);
    const otro = filaDe("Roles propios", PRACTICANTE.nombre);
    expect(within(otro).getByRole("button", { name: "Editar" })).toBeTruthy();
    expect(within(otro).getByRole("button", { name: "Eliminar" })).toBeTruthy();
  });

  it("GET /api/roles falla (500): mensaje genérico en alerta y sin tablas", async () => {
    instalarFetchFalso(
      rutasRoles({ "GET /api/roles": { status: 500, cuerpo: {} } }),
    );
    render(<Roles />);
    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toContain(MENSAJES_ACCESO.errorGeneral);
    expect(screen.queryByRole("table", { name: "Roles propios" })).toBeNull();
  });

  it("eliminar: DELETE /api/roles/:id con X-CSRF-Token, mensaje y recarga de la lista", async () => {
    const f = instalarFetchFalso(
      rutasRoles({
        [`DELETE /api/roles/${ID_AUDITOR}`]: { status: 204 },
      }),
    );
    render(<Roles />);
    await screen.findByRole("table", { name: "Roles propios" });
    const user = userEvent.setup();
    await user.click(
      within(filaDe("Roles propios", AUDITOR.nombre)).getByRole("button", {
        name: "Eliminar",
      }),
    );
    expect(await screen.findByText(MENSAJES_ROLES.rolEliminado)).toBeTruthy();
    const [llamada] = f.de(`DELETE /api/roles/${ID_AUDITOR}`);
    expect(llamada?.headers["x-csrf-token"]).toBe("csrf-acceso-1");
    await vi.waitFor(() => expect(f.de("GET /api/roles")).toHaveLength(2));
  });

  it("eliminar un rol en uso: 409 rol_en_uso muestra los conteos y no recarga", async () => {
    const f = instalarFetchFalso(
      rutasRoles({
        [`DELETE /api/roles/${ID_PRACTICANTE}`]: {
          status: 409,
          cuerpo: { codigo: "rol_en_uso", miembros: 2, invitaciones: 1 },
        },
      }),
    );
    const { container } = render(<Roles />);
    await screen.findByRole("table", { name: "Roles propios" });
    const user = userEvent.setup();
    await user.click(
      within(filaDe("Roles propios", PRACTICANTE.nombre)).getByRole("button", {
        name: "Eliminar",
      }),
    );
    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toContain(MENSAJES_ROLES.enUso(2, 1));
    expect(container.textContent).not.toContain("rol_en_uso");
    await asentar();
    expect(f.de("GET /api/roles")).toHaveLength(1);
    expect(filaDe("Roles propios", PRACTICANTE.nombre)).toBeTruthy();
  });

  it.each([
    [403, "rol_propio", MENSAJES_ROLES.rolPropio],
    [403, "permiso_denegado", MENSAJES_ACCESO.sinPermiso],
    [404, "no_encontrado", MENSAJES_ACCESO.noEncontrado],
    [500, "boom_interno", MENSAJES_ACCESO.errorGeneral],
  ])(
    "eliminar: %i %s → su mensaje, sin mostrar el código",
    async (status, codigo, mensaje) => {
      instalarFetchFalso(
        rutasRoles({
          [`DELETE /api/roles/${ID_AUDITOR}`]: { status, cuerpo: { codigo } },
        }),
      );
      const { container } = render(<Roles />);
      await screen.findByRole("table", { name: "Roles propios" });
      const user = userEvent.setup();
      await user.click(
        within(filaDe("Roles propios", AUDITOR.nombre)).getByRole("button", {
          name: "Eliminar",
        }),
      );
      const alerta = await screen.findByRole("alert");
      expect(alerta.textContent).toContain(mensaje);
      expect(container.textContent).not.toContain(codigo);
    },
  );

  it("nunca muestra secretos aunque el servidor los incluya", async () => {
    const f = instalarFetchFalso(
      rutasRoles({
        "GET /api/roles": {
          status: 200,
          cuerpo: {
            sistema: [],
            propios: [{ ...PRACTICANTE, clave: "CanarioQueNuncaDebeVerse" }],
          },
        },
      }),
    );
    const { container } = render(<Roles />);
    await screen.findByRole("table", { name: "Roles propios" });
    expect(container.innerHTML).not.toContain("CanarioQueNuncaDebeVerse");
    expect(f.de("GET /api/roles")).toHaveLength(1);
  });
});

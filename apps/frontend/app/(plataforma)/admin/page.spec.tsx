import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../../lib/sesion";
import {
  MENSAJES_ACCESO,
  asentar,
  celdas,
  esperarFila,
  fila,
} from "../../../pruebas/acceso";
import {
  ESTUDIO_SIN_PLAN,
  ESTUDIOS,
  MENSAJES_PLANES,
  PLANES,
} from "../../../pruebas/planes";
import {
  crearRouterFalso,
  instalarFetchFalso,
  sesionDe,
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
  usePathname: () => "/admin",
  useSearchParams: () => new URLSearchParams(),
}));

import AdminEstudios from "./page";

// Contrato (plan 006, HTTP; D5, D10, D13, CA-1, CA-10). Pantalla /admin del super-admin (sin estudio
// activo): asignación de plan a estudios.
// - Al montar: GET /api/plataforma/yo. Con 403 muestra MENSAJES_ACCESO.sinPermiso y no pide nada más,
//   ni muestra tabla, botones ni enlaces. Con 200: GET /api/plataforma/estudios y GET /api/plataforma/planes.
// - Enlace "Planes" a /admin/planes.
// - Tabla (role=row), una fila por estudio: celdas de texto con el nombre, el nombre del plan y el
//   estado ("prueba" | "activa" tal cual lo da el servidor). Cada fila tiene un select "Plan" (solo
//   planes activos: un plan inactivo no se ofrece; value = el id del plan; preseleccionado el actual
//   por código), un campo numérico "RUCs adicionales" (valor inicial 0) y el botón "Asignar plan".
// - "Asignar plan" → PUT /api/plataforma/estudios/:tenantId/suscripcion { planId, rucsExtraContratados:
//   number } con CSRF de la sesión. 200 → MENSAJES_PLANES.suscripcionGuardada y recarga estudios.
//   Errores (role=alert): 409 plan_inactivo → planInactivo; 400 → extraInvalido; 404 → noEncontrado;
//   403 → sinPermiso.
// - D14 (T13a): un estudio sin suscripción llega con `plan: null` y `estado: null`. Su fila muestra "Sin plan" (no
//   rompe la tabla ni muestra "null") y permite asignarle uno con el mismo "Asignar plan" (PUT /suscripcion).

const sesion: Record<string, Manejador> = {
  "GET /api/auth/sesion": { status: 200, cuerpo: sesionDe(null, "csrf-admin") },
};

function rutas(
  extra: Record<string, Manejador> = {},
): Record<string, Manejador> {
  return {
    ...sesion,
    "GET /api/plataforma/yo": { status: 200, cuerpo: { admin: true } },
    "GET /api/plataforma/estudios": { status: 200, cuerpo: ESTUDIOS },
    "GET /api/plataforma/planes": { status: 200, cuerpo: PLANES },
    ...extra,
  };
}

describe("/admin", () => {
  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    reiniciarSesion();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("lista los estudios con su plan y estado, y enlaza a /admin/planes", async () => {
    instalarFetchFalso(rutas());
    render(<AdminEstudios />);
    const alfa = celdas(await esperarFila("Estudio Alfa"));
    expect(alfa).toContain("Estudio");
    expect(alfa).toContain("activa");
    const beta = celdas(await esperarFila("Estudio Beta"));
    expect(beta).toContain("Prueba");
    expect(beta).toContain("prueba");
    expect(
      screen.getByRole("link", { name: "Planes" }).getAttribute("href"),
    ).toBe("/admin/planes");
  });

  it("403 en /plataforma/yo → sin permiso, sin tabla, sin acciones y sin pedir estudios ni planes", async () => {
    const f = instalarFetchFalso({
      ...sesion,
      "GET /api/plataforma/yo": {
        status: 403,
        cuerpo: { codigo: "permiso_denegado" },
      },
    });
    render(<AdminEstudios />);
    expect(await screen.findByText(MENSAJES_ACCESO.sinPermiso)).toBeTruthy();
    await asentar();
    expect(f.de("GET /api/plataforma/estudios")).toHaveLength(0);
    expect(f.de("GET /api/plataforma/planes")).toHaveLength(0);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryAllByRole("row")).toHaveLength(0);
  });

  it("el select de plan ofrece solo planes activos y preselecciona el actual", async () => {
    instalarFetchFalso(rutas());
    render(<AdminEstudios />);
    const beta = await esperarFila("Estudio Beta");
    const select = within(beta).getByLabelText("Plan") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value).sort()).toEqual(
      ["p-corp", "p-estudio", "p-prueba"].sort(),
    );
    expect(select.value).toBe("p-prueba");
    const alfa = await esperarFila("Estudio Alfa");
    expect(
      (within(alfa).getByLabelText("Plan") as HTMLSelectElement).value,
    ).toBe("p-estudio");
    expect(
      (within(beta).getByLabelText("RUCs adicionales") as HTMLInputElement)
        .value,
    ).toBe("0");
  });

  it("asignar: PUT /suscripcion { planId, rucsExtraContratados } con CSRF; 200 → guardada y recarga", async () => {
    const f = instalarFetchFalso(
      rutas({
        "PUT /api/plataforma/estudios/t-beta/suscripcion": {
          status: 200,
          cuerpo: {
            estudioId: "t-beta",
            plan: { codigo: "estudio", nombre: "Estudio" },
            estado: "activa",
            rucsExtraContratados: 8,
          },
        },
      }),
    );
    render(<AdminEstudios />);
    const user = userEvent.setup();
    const beta = await esperarFila("Estudio Beta");
    await user.selectOptions(within(beta).getByLabelText("Plan"), "p-estudio");
    const extra = within(beta).getByLabelText("RUCs adicionales");
    await user.clear(extra);
    await user.type(extra, "8");
    await user.click(
      within(beta).getByRole("button", { name: "Asignar plan" }),
    );
    expect(
      await screen.findByText(MENSAJES_PLANES.suscripcionGuardada),
    ).toBeTruthy();
    const [llamada] = f.de("PUT /api/plataforma/estudios/t-beta/suscripcion");
    expect(llamada?.body).toEqual({
      planId: "p-estudio",
      rucsExtraContratados: 8,
    });
    expect(llamada?.headers["x-csrf-token"]).toBe("csrf-admin");
    expect(llamada?.headers["x-estudio"]).toBeUndefined();
    await vi.waitFor(() =>
      expect(f.de("GET /api/plataforma/estudios")).toHaveLength(2),
    );
  });

  it.each([
    [409, { codigo: "plan_inactivo" }, MENSAJES_PLANES.planInactivo],
    [400, { codigo: "solicitud_invalida" }, MENSAJES_PLANES.extraInvalido],
    [404, { codigo: "no_encontrado" }, MENSAJES_ACCESO.noEncontrado],
    [403, { codigo: "permiso_denegado" }, MENSAJES_ACCESO.sinPermiso],
  ])(
    "asignar: %i → mensaje claro sin eco del servidor",
    async (status, cuerpo, mensaje) => {
      instalarFetchFalso(
        rutas({
          "PUT /api/plataforma/estudios/t-alfa/suscripcion": { status, cuerpo },
        }),
      );
      render(<AdminEstudios />);
      const alfa = await esperarFila("Estudio Alfa");
      await userEvent
        .setup()
        .click(within(alfa).getByRole("button", { name: "Asignar plan" }));
      const alerta = await screen.findByRole("alert");
      expect(within(alerta).getByText(mensaje)).toBeTruthy();
      expect(alerta.textContent).not.toContain(
        (cuerpo as { codigo: string }).codigo,
      );
    },
  );

  it("D14 · un estudio con plan nulo se muestra como 'Sin plan' y la tabla sigue mostrando los demás", async () => {
    instalarFetchFalso(
      rutas({
        "GET /api/plataforma/estudios": {
          status: 200,
          cuerpo: [...ESTUDIOS, ESTUDIO_SIN_PLAN],
        },
      }),
    );
    const { container } = render(<AdminEstudios />);
    const gamma = celdas(await esperarFila("Estudio Gamma"));
    expect(gamma).toContain("Sin plan");
    expect(container.textContent).not.toMatch(/null|undefined/);
    expect(celdas(await esperarFila("Estudio Alfa"))).toContain("activa");
  });

  it("D14 · asignar un plan a un estudio sin plan: PUT /suscripcion { planId, rucsExtraContratados } con CSRF", async () => {
    const f = instalarFetchFalso(
      rutas({
        "GET /api/plataforma/estudios": (_l, vez) => ({
          status: 200,
          cuerpo:
            vez === 1
              ? [ESTUDIO_SIN_PLAN]
              : [
                  {
                    ...ESTUDIO_SIN_PLAN,
                    plan: { codigo: "estudio", nombre: "Estudio" },
                    estado: "activa",
                  },
                ],
        }),
        "PUT /api/plataforma/estudios/t-gamma/suscripcion": {
          status: 200,
          cuerpo: {
            estudioId: "t-gamma",
            plan: { codigo: "estudio", nombre: "Estudio" },
            estado: "activa",
            rucsExtraContratados: 0,
          },
        },
      }),
    );
    render(<AdminEstudios />);
    const user = userEvent.setup();
    const gamma = await esperarFila("Estudio Gamma");
    await user.selectOptions(within(gamma).getByLabelText("Plan"), "p-estudio");
    await user.click(
      within(gamma).getByRole("button", { name: "Asignar plan" }),
    );
    expect(
      await screen.findByText(MENSAJES_PLANES.suscripcionGuardada),
    ).toBeTruthy();
    const [llamada] = f.de("PUT /api/plataforma/estudios/t-gamma/suscripcion");
    expect(llamada?.body).toEqual({
      planId: "p-estudio",
      rucsExtraContratados: 0,
    });
    expect(llamada?.headers["x-csrf-token"]).toBe("csrf-admin");
    await vi.waitFor(() =>
      expect(celdas(fila("Estudio Gamma"))).toContain("activa"),
    );
  });
});

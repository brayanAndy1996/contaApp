import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../../../lib/sesion";
import {
  MENSAJES_ACCESO,
  asentar,
  celdas,
  esperarFila,
} from "../../../../pruebas/acceso";
import { MENSAJES_PLANES, PLANES } from "../../../../pruebas/planes";
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
  usePathname: () => "/admin/planes",
  useSearchParams: () => new URLSearchParams(),
}));

import AdminPlanes from "./page";

// Contrato (plan 006, HTTP; CA-1, CA-10, D5, D11). Pantalla /admin/planes del super-admin (sin estudio
// activo: la sesión no trae X-Estudio):
// - Al montar: GET /api/plataforma/yo. Con 403 muestra MENSAJES_ACCESO.sinPermiso y no pide nada más
//   ni muestra formularios ni acciones. Con 200: GET /api/plataforma/planes.
// - Tabla (role=row), una fila por plan, celdas de texto: código, nombre, precio mensual (la cadena
//   del servidor, p. ej. "249.00"), máximo de RUCs, máximo de usuarios ("Ilimitado" si es nulo) y estado
//   "Activo" | "Inactivo". Cada fila: botón "Editar" y, si activo, "Desactivar"; si inactivo, "Activar".
// - Formulario (siempre visible) con campos de etiqueta: "Código", "Nombre", "Precio mensual",
//   "Precio anual" (vacío = sin precio anual), "Máximo de RUCs", "Máximo de usuarios" (vacío =
//   ilimitado), "Precio por RUC extra", "Máximo de RUCs extra", "Frecuencia del buzón (min)" y
//   "Características (JSON)" (por defecto "{}"). Botón "Crear plan" → POST /api/plataforma/planes con
//   { codigo, nombre, precioMensual:string, precioAnual:string|null, maxRucs:number,
//   maxUsuarios:number|null, precioRucExtra:string, maxRucsExtra:number, frecuenciaBuzonMin:number,
//   features:objeto, activo:true } y CSRF de la sesión. 201 → MENSAJES_PLANES.planCreado y recarga la
//   lista. "Características" que no sea un objeto JSON → featuresInvalidas, sin petición.
// - "Editar" carga la fila en el formulario y cambia el botón a "Guardar cambios" →
//   PUT /api/plataforma/planes/:id con el reemplazo completo (mismo cuerpo, incluye `activo`). 200 →
//   planGuardado y recarga.
// - "Desactivar"/"Activar" → PUT /planes/:id con el plan completo y `activo` invertido; recarga.
// - Errores del servidor (role=alert), sin eco del cuerpo: 400 → planInvalido (el formulario conserva
//   lo escrito); 409 codigo_existente → codigoExistente; 404 → noEncontrado; 403 → sinPermiso.

const sesion: Record<string, Manejador> = {
  "GET /api/auth/sesion": { status: 200, cuerpo: sesionDe(null, "csrf-admin") },
};

function rutas(
  extra: Record<string, Manejador> = {},
): Record<string, Manejador> {
  return {
    ...sesion,
    "GET /api/plataforma/yo": { status: 200, cuerpo: { admin: true } },
    "GET /api/plataforma/planes": { status: 200, cuerpo: PLANES },
    ...extra,
  };
}

const quitar = (f: HTMLElement, nombre: string) =>
  within(f).queryByRole("button", { name: nombre });

async function llenar(
  user: ReturnType<typeof userEvent.setup>,
  v: Record<string, string>,
) {
  for (const [etiqueta, valor] of Object.entries(v)) {
    const campo = screen.getByLabelText(etiqueta);
    await user.clear(campo);
    if (valor) await user.type(campo, valor);
  }
}

const NUEVO = {
  Código: "independiente",
  Nombre: "Independiente",
  "Precio mensual": "99.00",
  "Precio anual": "990.00",
  "Máximo de RUCs": "30",
  "Máximo de usuarios": "2",
  "Precio por RUC extra": "4.00",
  "Máximo de RUCs extra": "6",
  "Frecuencia del buzón (min)": "1440",
};

describe("/admin/planes", () => {
  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    reiniciarSesion();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("lista los planes con código, nombre, precio, límites y estado", async () => {
    instalarFetchFalso(rutas());
    render(<AdminPlanes />);
    const estudio = celdas(await esperarFila("estudio"));
    expect(estudio).toContain("Estudio");
    expect(estudio).toContain("249.00");
    expect(estudio).toContain("100");
    expect(estudio).toContain("5");
    expect(estudio).toContain("Activo");
    expect(celdas(await esperarFila("corporativo"))).toContain("Ilimitado");
    expect(celdas(await esperarFila("heredado"))).toContain("Inactivo");
  });

  it("cada fila ofrece Editar y Desactivar (activo) o Activar (inactivo)", async () => {
    instalarFetchFalso(rutas());
    render(<AdminPlanes />);
    const activo = await esperarFila("corporativo");
    expect(quitar(activo, "Editar")).toBeTruthy();
    expect(quitar(activo, "Desactivar")).toBeTruthy();
    expect(quitar(activo, "Activar")).toBeNull();
    const inactivo = await esperarFila("heredado");
    expect(quitar(inactivo, "Activar")).toBeTruthy();
    expect(quitar(inactivo, "Desactivar")).toBeNull();
  });

  it("403 en /plataforma/yo → sin permiso, sin formulario, sin acciones y sin pedir planes", async () => {
    const f = instalarFetchFalso({
      ...sesion,
      "GET /api/plataforma/yo": {
        status: 403,
        cuerpo: { codigo: "permiso_denegado" },
      },
    });
    render(<AdminPlanes />);
    expect(await screen.findByText(MENSAJES_ACCESO.sinPermiso)).toBeTruthy();
    await asentar();
    expect(f.de("GET /api/plataforma/planes")).toHaveLength(0);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByLabelText("Código")).toBeNull();
    expect(screen.queryAllByRole("row")).toHaveLength(0);
  });

  it("crear: POST /api/plataforma/planes con el cuerpo completo y CSRF; 201 → planCreado y recarga", async () => {
    const f = instalarFetchFalso(
      rutas({
        "POST /api/plataforma/planes": {
          status: 201,
          cuerpo: { ...PLANES[1], id: "p-nuevo", codigo: "independiente" },
        },
      }),
    );
    render(<AdminPlanes />);
    await esperarFila("estudio");
    const user = userEvent.setup();
    expect(
      (screen.getByLabelText("Características (JSON)") as HTMLTextAreaElement)
        .value,
    ).toBe("{}");
    await llenar(user, NUEVO);
    await user.click(screen.getByRole("button", { name: "Crear plan" }));
    expect(await screen.findByText(MENSAJES_PLANES.planCreado)).toBeTruthy();
    const [llamada] = f.de("POST /api/plataforma/planes");
    expect(llamada?.body).toEqual({
      codigo: "independiente",
      nombre: "Independiente",
      precioMensual: "99.00",
      precioAnual: "990.00",
      maxRucs: 30,
      maxUsuarios: 2,
      precioRucExtra: "4.00",
      maxRucsExtra: 6,
      frecuenciaBuzonMin: 1440,
      features: {},
      activo: true,
    });
    expect(llamada?.headers["x-csrf-token"]).toBe("csrf-admin");
    expect(llamada?.headers["x-estudio"]).toBeUndefined();
    await vi.waitFor(() =>
      expect(f.de("GET /api/plataforma/planes")).toHaveLength(2),
    );
  });

  it("crear con precio anual y máximo de usuarios vacíos envía null", async () => {
    const f = instalarFetchFalso(
      rutas({
        "POST /api/plataforma/planes": { status: 201, cuerpo: PLANES[2] },
      }),
    );
    render(<AdminPlanes />);
    await esperarFila("estudio");
    const user = userEvent.setup();
    await llenar(user, {
      ...NUEVO,
      "Precio anual": "",
      "Máximo de usuarios": "",
    });
    await user.click(screen.getByRole("button", { name: "Crear plan" }));
    await screen.findByText(MENSAJES_PLANES.planCreado);
    const cuerpo = f.de("POST /api/plataforma/planes")[0]?.body as Record<
      string,
      unknown
    >;
    expect(cuerpo.precioAnual).toBeNull();
    expect(cuerpo.maxUsuarios).toBeNull();
  });

  it("características que no son un objeto JSON → mensaje y sin petición", async () => {
    const f = instalarFetchFalso(rutas());
    render(<AdminPlanes />);
    await esperarFila("estudio");
    const user = userEvent.setup();
    await llenar(user, NUEVO);
    const campo = screen.getByLabelText("Características (JSON)");
    await user.clear(campo);
    await user.click(campo);
    await user.paste("[1, 2");
    await user.click(screen.getByRole("button", { name: "Crear plan" }));
    expect(
      await screen.findByText(MENSAJES_PLANES.featuresInvalidas),
    ).toBeTruthy();
    expect(f.de("POST /api/plataforma/planes")).toHaveLength(0);
  });

  it("crear: 400 → planInvalido sin eco del servidor, y el formulario conserva lo escrito", async () => {
    instalarFetchFalso(
      rutas({
        "POST /api/plataforma/planes": {
          status: 400,
          cuerpo: {
            codigo: "solicitud_invalida",
            detalle: "max_rucs_extra_interno",
          },
        },
      }),
    );
    const { container } = render(<AdminPlanes />);
    await esperarFila("estudio");
    const user = userEvent.setup();
    await llenar(user, NUEVO);
    await user.click(screen.getByRole("button", { name: "Crear plan" }));
    expect(await screen.findByText(MENSAJES_PLANES.planInvalido)).toBeTruthy();
    expect(container.textContent).not.toContain("max_rucs_extra_interno");
    expect((screen.getByLabelText("Código") as HTMLInputElement).value).toBe(
      "independiente",
    );
    expect(
      (screen.getByLabelText("Máximo de RUCs extra") as HTMLInputElement).value,
    ).toBe("6");
  });

  it("crear: 409 codigo_existente → mensaje de código existente", async () => {
    instalarFetchFalso(
      rutas({
        "POST /api/plataforma/planes": {
          status: 409,
          cuerpo: { codigo: "codigo_existente" },
        },
      }),
    );
    render(<AdminPlanes />);
    await esperarFila("estudio");
    const user = userEvent.setup();
    await llenar(user, NUEVO);
    await user.click(screen.getByRole("button", { name: "Crear plan" }));
    expect(
      await screen.findByText(MENSAJES_PLANES.codigoExistente),
    ).toBeTruthy();
  });

  it("crear: 403 → sin permiso", async () => {
    instalarFetchFalso(
      rutas({
        "POST /api/plataforma/planes": {
          status: 403,
          cuerpo: { codigo: "permiso_denegado" },
        },
      }),
    );
    render(<AdminPlanes />);
    await esperarFila("estudio");
    const user = userEvent.setup();
    await llenar(user, NUEVO);
    await user.click(screen.getByRole("button", { name: "Crear plan" }));
    expect(await screen.findByText(MENSAJES_ACCESO.sinPermiso)).toBeTruthy();
  });

  it("editar: carga la fila, cambia a 'Guardar cambios' y hace PUT con el reemplazo completo", async () => {
    const f = instalarFetchFalso(
      rutas({
        "PUT /api/plataforma/planes/p-estudio": {
          status: 200,
          cuerpo: PLANES[1],
        },
      }),
    );
    render(<AdminPlanes />);
    const fila = await esperarFila("estudio");
    const user = userEvent.setup();
    await user.click(within(fila).getByRole("button", { name: "Editar" }));
    expect((screen.getByLabelText("Código") as HTMLInputElement).value).toBe(
      "estudio",
    );
    expect(
      (screen.getByLabelText("Precio mensual") as HTMLInputElement).value,
    ).toBe("249.00");
    expect(screen.queryByRole("button", { name: "Crear plan" })).toBeNull();
    await llenar(user, {
      "Máximo de RUCs": "120",
      "Máximo de RUCs extra": "24",
    });
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));
    expect(await screen.findByText(MENSAJES_PLANES.planGuardado)).toBeTruthy();
    const [llamada] = f.de("PUT /api/plataforma/planes/p-estudio");
    expect(llamada?.body).toEqual({
      codigo: "estudio",
      nombre: "Estudio",
      precioMensual: "249.00",
      precioAnual: "2490.00",
      maxRucs: 120,
      maxUsuarios: 5,
      precioRucExtra: "4.00",
      maxRucsExtra: 24,
      frecuenciaBuzonMin: 720,
      features: { reportes: true },
      activo: true,
    });
    expect(llamada?.headers["x-csrf-token"]).toBe("csrf-admin");
  });

  it("editar: 400 del servidor → planInvalido y 404 → noEncontrado", async () => {
    instalarFetchFalso(
      rutas({
        "PUT /api/plataforma/planes/p-estudio": (_l, vez) =>
          vez === 1
            ? { status: 400, cuerpo: { codigo: "solicitud_invalida" } }
            : { status: 404, cuerpo: { codigo: "no_encontrado" } },
      }),
    );
    render(<AdminPlanes />);
    const fila = await esperarFila("estudio");
    const user = userEvent.setup();
    await user.click(within(fila).getByRole("button", { name: "Editar" }));
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));
    expect(await screen.findByText(MENSAJES_PLANES.planInvalido)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));
    expect(await screen.findByText(MENSAJES_ACCESO.noEncontrado)).toBeTruthy();
  });

  it("Desactivar hace PUT con el plan completo y activo=false, y recarga; Activar lo invierte", async () => {
    const f = instalarFetchFalso(
      rutas({
        "PUT /api/plataforma/planes/p-corp": { status: 200, cuerpo: PLANES[2] },
        "PUT /api/plataforma/planes/p-viejo": {
          status: 200,
          cuerpo: PLANES[3],
        },
      }),
    );
    render(<AdminPlanes />);
    const user = userEvent.setup();
    await user.click(
      within(await esperarFila("corporativo")).getByRole("button", {
        name: "Desactivar",
      }),
    );
    await vi.waitFor(() =>
      expect(f.de("PUT /api/plataforma/planes/p-corp")).toHaveLength(1),
    );
    const sinId: Record<string, unknown> = { ...PLANES[2]! };
    delete sinId.id;
    expect(f.de("PUT /api/plataforma/planes/p-corp")[0]?.body).toEqual({
      ...sinId,
      activo: false,
    });
    await vi.waitFor(() =>
      expect(f.de("GET /api/plataforma/planes")).toHaveLength(2),
    );
    await user.click(
      within(await esperarFila("heredado")).getByRole("button", {
        name: "Activar",
      }),
    );
    await vi.waitFor(() =>
      expect(f.de("PUT /api/plataforma/planes/p-viejo")).toHaveLength(1),
    );
    expect(
      (
        f.de("PUT /api/plataforma/planes/p-viejo")[0]?.body as {
          activo: boolean;
        }
      ).activo,
    ).toBe(true);
  });
});

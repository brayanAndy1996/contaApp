import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../../../lib/sesion";
import {
  MENSAJES_ACCESO,
  asentar,
  rutaSesion,
  yoDe,
} from "../../../../pruebas/acceso";
import { MENSAJES_CLIENTES, clienteDe } from "../../../../pruebas/clientes";
import { MENSAJES_PLANES, usoDe } from "../../../../pruebas/planes";
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

// Contrato (plan 007a, shared y HTTP; D3, D5, D7; CA-4, CA-5, CA-9). Detalle /clientes/c-1, además de
// lo de 005 (asignaciones). Al montar: GET /api/acceso/yo y GET /api/clientes/c-1 (ClienteDto).
// - Sección "Datos fiscales" (región con ese nombre): muestra los valores del perfil. Con
//   `clientes.editar` y cliente activo es un formulario con: cuadro de texto "Razón social", select
//   "Régimen" ("" = sin definir | rg | rmt | rer | nrus), select "Zona" (general | amazonia), casillas
//   "Ventas exoneradas" y "Ventas mixtas", select "Moneda habitual" (PEN | USD) y botón "Guardar datos
//   fiscales". Los controles cargan los valores del DTO.
// - Guardar: PATCH /api/clientes/c-1 { razonSocial, perfil: {regimen (null si ""), zona, ventasExoneradas,
//   ventasMixtas, monedaHabitual} } con X-CSRF-Token. 200 → MENSAJES_CLIENTES.datosGuardados y los
//   controles reflejan el DTO devuelto. 400 → datosInvalidos. 409 cliente_archivado → clienteArchivado.
//   403 → sinPermiso.
// - Sin `clientes.editar`: sin botón "Guardar datos fiscales" y sin controles editables (los selects y
//   casillas, si se muestran, están deshabilitados).
// - Archivar (permiso `clientes.archivar`, cliente activo): botón "Archivar" → diálogo de confirmación
//   (role=alertdialog) con botones "Confirmar" y "Cancelar". Cancelar no llama a la API. Confirmar:
//   POST /api/clientes/c-1/archivar con CSRF (sin cuerpo relevante) → 200 ClienteDto archivado; la
//   pantalla pasa a modo archivado.
// - Reactivar (permiso `clientes.archivar`, cliente archivado): botón "Reactivar" → mismo diálogo →
//   POST /api/clientes/c-1/reactivar. 409 cupo_rucs → MENSAJES_PLANES.limiteRucs y el uso del plan
//   (región "Uso del plan", GET /api/plan/uso); el cliente sigue archivado.
// - Sin `clientes.archivar`: ni "Archivar" ni "Reactivar".
// - Archivado (modo solo lectura, D5): texto MENSAJES_CLIENTES.clienteArchivado, sin "Guardar datos
//   fiscales", controles fiscales deshabilitados y sin el formulario/botón "Asignar" ni "Quitar" de
//   asignaciones aunque el rol tenga `clientes.asignar`.

const PERFIL = {
  regimen: "rmt",
  zona: "general",
  ventasExoneradas: false,
  ventasMixtas: true,
  monedaHabitual: "USD",
};
const ACTIVO = clienteDe({ perfil: PERFIL });
const ARCHIVADO = clienteDe({ perfil: PERFIL, archivado: true });

function rutas(
  cliente: unknown,
  permisos: string[],
  extra: Record<string, Manejador> = {},
) {
  return {
    ...rutaSesion(),
    "GET /api/acceso/yo": { status: 200, cuerpo: yoDe("dueno", permisos) },
    "GET /api/clientes/c-1": { status: 200, cuerpo: cliente },
    "GET /api/clientes/c-1/asignaciones": { status: 200, cuerpo: [] },
    "GET /api/usuarios": { status: 200, cuerpo: [] },
    "GET /api/plan/uso": {
      status: 200,
      cuerpo: usoDe({
        rucs: { usados: 100, limite: 100, libres: 0, extra: 0 },
      }),
    },
    ...extra,
  };
}
const EDITAR = ["clientes.ver", "clientes.editar"];
const ARCHIVAR = ["clientes.ver", "clientes.archivar"];

const fiscal = () => screen.findByRole("region", { name: "Datos fiscales" });
const valor = (el: HTMLElement) =>
  (el as HTMLSelectElement | HTMLInputElement).value;

describe("/clientes/:id · datos fiscales y archivado (007a)", () => {
  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    reiniciarSesion();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("carga los datos fiscales en los controles", async () => {
    instalarFetchFalso(rutas(ACTIVO, EDITAR));
    render(<Cliente />);
    const region = await fiscal();
    await vi.waitFor(() =>
      expect(valor(within(region).getByLabelText("Régimen"))).toBe("rmt"),
    );
    expect(valor(within(region).getByLabelText("Zona"))).toBe("general");
    expect(valor(within(region).getByLabelText("Moneda habitual"))).toBe("USD");
    expect(
      (within(region).getByLabelText("Ventas mixtas") as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(
      (within(region).getByLabelText("Ventas exoneradas") as HTMLInputElement)
        .checked,
    ).toBe(false);
    expect(valor(within(region).getByLabelText("Razón social"))).toBe(
      "Alfa SAC",
    );
  });

  it("editar: PATCH con el perfil completo y CSRF; muestra 'Datos guardados.'", async () => {
    const nuevo = clienteDe({
      perfil: {
        regimen: "rg",
        zona: "amazonia",
        ventasExoneradas: true,
        ventasMixtas: true,
        monedaHabitual: "PEN",
      },
    });
    const f = instalarFetchFalso(
      rutas(ACTIVO, EDITAR, {
        "PATCH /api/clientes/c-1": { status: 200, cuerpo: nuevo },
      }),
    );
    render(<Cliente />);
    const region = await fiscal();
    await vi.waitFor(() =>
      expect(valor(within(region).getByLabelText("Régimen"))).toBe("rmt"),
    );
    const user = userEvent.setup();
    await user.selectOptions(within(region).getByLabelText("Régimen"), "rg");
    await user.selectOptions(within(region).getByLabelText("Zona"), "amazonia");
    await user.click(within(region).getByLabelText("Ventas exoneradas"));
    await user.selectOptions(
      within(region).getByLabelText("Moneda habitual"),
      "PEN",
    );
    await user.click(
      within(region).getByRole("button", { name: "Guardar datos fiscales" }),
    );
    await vi.waitFor(() =>
      expect(f.de("PATCH /api/clientes/c-1")).toHaveLength(1),
    );
    const [llamada] = f.de("PATCH /api/clientes/c-1");
    expect((llamada?.body as { perfil: unknown }).perfil).toEqual({
      regimen: "rg",
      zona: "amazonia",
      ventasExoneradas: true,
      ventasMixtas: true,
      monedaHabitual: "PEN",
    });
    expect(llamada?.headers["x-csrf-token"]).toBe("csrf-acceso-1");
    expect(
      await screen.findByText(MENSAJES_CLIENTES.datosGuardados),
    ).toBeTruthy();
  });

  it("régimen 'sin definir' se envía como null", async () => {
    const f = instalarFetchFalso(
      rutas(ACTIVO, EDITAR, {
        "PATCH /api/clientes/c-1": { status: 200, cuerpo: ACTIVO },
      }),
    );
    render(<Cliente />);
    const region = await fiscal();
    await vi.waitFor(() =>
      expect(valor(within(region).getByLabelText("Régimen"))).toBe("rmt"),
    );
    const user = userEvent.setup();
    await user.selectOptions(within(region).getByLabelText("Régimen"), "");
    await user.click(
      within(region).getByRole("button", { name: "Guardar datos fiscales" }),
    );
    await vi.waitFor(() =>
      expect(f.de("PATCH /api/clientes/c-1")).toHaveLength(1),
    );
    const cuerpo = f.de("PATCH /api/clientes/c-1")[0]?.body as {
      perfil: { regimen: unknown };
    };
    expect(cuerpo.perfil.regimen).toBeNull();
  });

  it.each<[string, number, unknown, string]>([
    [
      "400 del catálogo",
      400,
      { codigo: "validacion" },
      MENSAJES_CLIENTES.datosInvalidos,
    ],
    [
      "409 cliente_archivado",
      409,
      { codigo: "cliente_archivado" },
      MENSAJES_CLIENTES.clienteArchivado,
    ],
    ["403", 403, { codigo: "prohibido" }, MENSAJES_ACCESO.sinPermiso],
  ])("PATCH %s → mensaje propio", async (_n, status, cuerpo, mensaje) => {
    instalarFetchFalso(
      rutas(ACTIVO, EDITAR, { "PATCH /api/clientes/c-1": { status, cuerpo } }),
    );
    render(<Cliente />);
    const region = await fiscal();
    await vi.waitFor(() =>
      expect(valor(within(region).getByLabelText("Régimen"))).toBe("rmt"),
    );
    const user = userEvent.setup();
    await user.click(
      within(region).getByRole("button", { name: "Guardar datos fiscales" }),
    );
    expect((await screen.findAllByText(mensaje)).length).toBeGreaterThan(0);
  });

  it("sin clientes.editar: sin botón de guardar y sin controles editables", async () => {
    instalarFetchFalso(rutas(ACTIVO, ["clientes.ver"]));
    render(<Cliente />);
    const region = await fiscal();
    await asentar();
    expect(
      within(region).queryByRole("button", { name: "Guardar datos fiscales" }),
    ).toBeNull();
    for (const c of within(region).queryAllByRole("combobox")) {
      expect((c as HTMLSelectElement).disabled).toBe(true);
    }
    for (const c of within(region).queryAllByRole("checkbox")) {
      expect((c as HTMLInputElement).disabled).toBe(true);
    }
  });

  it("archivar pide confirmación: Cancelar no llama a la API; Confirmar archiva y pasa a solo lectura", async () => {
    const f = instalarFetchFalso(
      rutas(ACTIVO, [...EDITAR, "clientes.archivar"], {
        "POST /api/clientes/c-1/archivar": { status: 200, cuerpo: ARCHIVADO },
      }),
    );
    render(<Cliente />);
    await fiscal();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Archivar" }));
    let dialogo = await screen.findByRole("alertdialog");
    await user.click(within(dialogo).getByRole("button", { name: "Cancelar" }));
    await vi.waitFor(() =>
      expect(screen.queryByRole("alertdialog")).toBeNull(),
    );
    expect(f.de("POST /api/clientes/c-1/archivar")).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Archivar" }));
    dialogo = await screen.findByRole("alertdialog");
    expect(f.de("POST /api/clientes/c-1/archivar")).toHaveLength(0);
    await user.click(
      within(dialogo).getByRole("button", { name: "Confirmar" }),
    );
    await vi.waitFor(() =>
      expect(f.de("POST /api/clientes/c-1/archivar")).toHaveLength(1),
    );
    expect(
      f.de("POST /api/clientes/c-1/archivar")[0]?.headers["x-csrf-token"],
    ).toBe("csrf-acceso-1");
    expect(
      await screen.findByText(MENSAJES_CLIENTES.clienteArchivado),
    ).toBeTruthy();
    expect(
      await screen.findByRole("button", { name: "Reactivar" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Guardar datos fiscales" }),
    ).toBeNull();
  });

  it("reactivar pide confirmación y llama a POST .../reactivar; el cliente vuelve a ser editable", async () => {
    const f = instalarFetchFalso(
      rutas(ARCHIVADO, [...EDITAR, "clientes.archivar"], {
        "POST /api/clientes/c-1/reactivar": { status: 200, cuerpo: ACTIVO },
      }),
    );
    render(<Cliente />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Reactivar" }));
    const dialogo = await screen.findByRole("alertdialog");
    expect(f.de("POST /api/clientes/c-1/reactivar")).toHaveLength(0);
    await user.click(
      within(dialogo).getByRole("button", { name: "Confirmar" }),
    );
    await vi.waitFor(() =>
      expect(f.de("POST /api/clientes/c-1/reactivar")).toHaveLength(1),
    );
    expect(
      await screen.findByRole("button", { name: "Guardar datos fiscales" }),
    ).toBeTruthy();
    expect(screen.queryByText(MENSAJES_CLIENTES.clienteArchivado)).toBeNull();
  });

  it("reactivar con 409 cupo_rucs: aviso de límite con el uso del plan; sigue archivado", async () => {
    const f = instalarFetchFalso(
      rutas(ARCHIVADO, ARCHIVAR, {
        "POST /api/clientes/c-1/reactivar": {
          status: 409,
          cuerpo: { codigo: "cupo_rucs" },
        },
      }),
    );
    render(<Cliente />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Reactivar" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Confirmar",
      }),
    );
    await vi.waitFor(() =>
      expect(
        screen.getAllByText(MENSAJES_PLANES.limiteRucs).length,
      ).toBeGreaterThan(0),
    );
    const uso = await screen.findByRole("region", { name: "Uso del plan" });
    expect(within(uso).getByText(/RUCs: 100 de 100/)).toBeTruthy();
    expect(f.de("GET /api/plan/uso").length).toBeGreaterThan(0);
    expect(screen.getByText(MENSAJES_CLIENTES.clienteArchivado)).toBeTruthy();
    // 018 T5a (CA-10): el aviso de límite se anuncia una sola vez.
    expect(
      screen
        .getAllByRole("alert")
        .filter((a) => (a.textContent ?? "").includes(MENSAJES_PLANES.limiteRucs)),
    ).toHaveLength(1);
  });

  // D2 (T13): el 409 sin_plan al reactivar se muestra como en el alta (MENSAJES_PLANES.sinPlan), no como error genérico.
  it("D2 · reactivar con 409 sin_plan: aviso de estudio sin plan; sigue archivado", async () => {
    instalarFetchFalso(
      rutas(ARCHIVADO, ARCHIVAR, {
        "POST /api/clientes/c-1/reactivar": {
          status: 409,
          cuerpo: { codigo: "sin_plan" },
        },
      }),
    );
    const { container } = render(<Cliente />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Reactivar" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Confirmar",
      }),
    );
    expect(
      (await screen.findAllByText(MENSAJES_PLANES.sinPlan)).length,
    ).toBeGreaterThan(0);
    expect(container.textContent).not.toContain(MENSAJES_ACCESO.errorGeneral);
    expect(screen.getByText(MENSAJES_CLIENTES.clienteArchivado)).toBeTruthy();
  });

  it("sin clientes.archivar: ni Archivar ni Reactivar", async () => {
    instalarFetchFalso(rutas(ACTIVO, EDITAR));
    render(<Cliente />);
    await fiscal();
    await asentar();
    expect(screen.queryByRole("button", { name: "Archivar" })).toBeNull();
    cleanup();

    instalarFetchFalso(rutas(ARCHIVADO, EDITAR));
    render(<Cliente />);
    await screen.findByText(MENSAJES_CLIENTES.clienteArchivado);
    expect(screen.queryByRole("button", { name: "Reactivar" })).toBeNull();
  });

  it("archivado: solo lectura (sin guardar, controles deshabilitados, sin asignar ni quitar)", async () => {
    instalarFetchFalso(
      rutas(ARCHIVADO, [...EDITAR, "clientes.asignar", "usuarios.ver"], {
        "GET /api/clientes/c-1/asignaciones": {
          status: 200,
          cuerpo: [
            {
              usuarioId: "u-ase",
              nombre: "Asia Asistente",
              tipo: "colaborador",
            },
          ],
        },
      }),
    );
    render(<Cliente />);
    expect(
      await screen.findByText(MENSAJES_CLIENTES.clienteArchivado),
    ).toBeTruthy();
    const region = await fiscal();
    await asentar();
    expect(
      within(region).queryByRole("button", { name: "Guardar datos fiscales" }),
    ).toBeNull();
    for (const c of within(region).queryAllByRole("combobox")) {
      expect((c as HTMLSelectElement).disabled).toBe(true);
    }
    for (const c of within(region).queryAllByRole("checkbox")) {
      expect((c as HTMLInputElement).disabled).toBe(true);
    }
    expect(screen.queryByRole("button", { name: "Asignar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Quitar" })).toBeNull();
  });
});

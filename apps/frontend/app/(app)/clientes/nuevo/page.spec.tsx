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
import {
  MENSAJES_CLIENTES,
  RUC_DIGITO_ERRADO,
  RUC_VALIDO,
  clienteDe,
} from "../../../../pruebas/clientes";
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
  usePathname: () => "/clientes/nuevo",
  useSearchParams: () => new URLSearchParams(),
}));

import NuevoCliente from "./page";

// Contrato (plan 007a, shared y HTTP; D2, D4; CA-1, CA-2, CA-9). Pantalla /clientes/nuevo:
// - Al montar: GET /api/acceso/yo. Sin `clientes.crear`: solo MENSAJES_ACCESO.sinPermiso, sin formulario.
// - Formulario: cuadro de texto "RUC", cuadro de texto "Razón social" (opcional) y botón "Crear cliente".
// - RUC en línea (D2, `validarRuc` de @contapp/shared): al salir del campo con un valor no vacío e
//   inválido aparece MENSAJES_CLIENTES.rucInvalido (role=alert), que desaparece al corregirlo. Enviar
//   con un RUC inválido muestra el mismo mensaje y NO llama a la API.
// - Enviar: POST /api/clientes { ruc, razonSocial? } (ruc recortado; razonSocial omitida si queda
//   vacía) con X-CSRF-Token. 201 ClienteDto → router.push("/clientes/<id>").
// - 409 cupo_rucs (D4): MENSAJES_PLANES.limiteRucs y el uso del plan (región "Uso del plan" de
//   <UsoPlan />, GET /api/plan/uso, p. ej. "RUCs: 100 de 100"); sin navegar.
// - 409 ruc_duplicado → MENSAJES_CLIENTES.rucDuplicado. 409 sin_plan → MENSAJES_PLANES.sinPlan.
//   400 → MENSAJES_PLANES.solicitudInvalida. 403 → MENSAJES_ACCESO.sinPermiso.

function rutas(permisos: string[], extra: Record<string, Manejador> = {}) {
  return {
    ...rutaSesion(),
    "GET /api/acceso/yo": { status: 200, cuerpo: yoDe("contador", permisos) },
    "GET /api/plan/uso": {
      status: 200,
      cuerpo: usoDe({
        rucs: { usados: 100, limite: 100, libres: 0, extra: 0 },
      }),
    },
    ...extra,
  };
}
const PUEDE = ["clientes.ver", "clientes.crear"];

async function escribir(ruc: string, razon = "") {
  const user = userEvent.setup();
  const campo = await screen.findByRole("textbox", { name: "RUC" });
  await user.type(campo, ruc);
  if (razon)
    await user.type(
      screen.getByRole("textbox", { name: "Razón social" }),
      razon,
    );
  return user;
}

describe("/clientes/nuevo", () => {
  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    reiniciarSesion();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sin clientes.crear: solo el mensaje de sin permiso, sin formulario", async () => {
    instalarFetchFalso(rutas(["clientes.ver"]));
    render(<NuevoCliente />);
    expect(await screen.findByText(MENSAJES_ACCESO.sinPermiso)).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "RUC" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Crear cliente" })).toBeNull();
  });

  it("RUC con dígito errado: error en línea al salir del campo; se quita al corregirlo", async () => {
    instalarFetchFalso(rutas(PUEDE));
    render(<NuevoCliente />);
    const user = await escribir(RUC_DIGITO_ERRADO);
    await user.tab();
    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toContain(MENSAJES_CLIENTES.rucInvalido);
    const campo = screen.getByRole("textbox", { name: "RUC" });
    await user.clear(campo);
    await user.type(campo, RUC_VALIDO);
    await user.tab();
    await vi.waitFor(() =>
      expect(screen.queryByText(MENSAJES_CLIENTES.rucInvalido)).toBeNull(),
    );
  });

  it.each([
    ["longitud 10", "2010000000"],
    ["prefijo 11", "11000000000"],
    ["letras", "2010000000a"],
  ])(
    "RUC inválido (%s): enviar muestra el error y no llama a la API",
    async (_n, ruc) => {
      const f = instalarFetchFalso(rutas(PUEDE));
      render(<NuevoCliente />);
      const user = await escribir(ruc);
      await user.click(screen.getByRole("button", { name: "Crear cliente" }));
      expect(
        await screen.findByText(MENSAJES_CLIENTES.rucInvalido),
      ).toBeTruthy();
      await asentar();
      expect(f.de("POST /api/clientes")).toHaveLength(0);
      expect(router.push).not.toHaveBeenCalled();
    },
  );

  it("alta válida: POST {ruc, razonSocial} con CSRF y navega al detalle", async () => {
    const f = instalarFetchFalso(
      rutas(PUEDE, {
        "POST /api/clientes": {
          status: 201,
          cuerpo: clienteDe({
            id: "c-77",
            ruc: RUC_VALIDO,
            razonSocial: "Nueva SAC",
          }),
        },
      }),
    );
    render(<NuevoCliente />);
    const user = await escribir(`  ${RUC_VALIDO}  `, "Nueva SAC");
    await user.click(screen.getByRole("button", { name: "Crear cliente" }));
    await vi.waitFor(() => expect(f.de("POST /api/clientes")).toHaveLength(1));
    const [llamada] = f.de("POST /api/clientes");
    expect(llamada?.body).toEqual({
      ruc: RUC_VALIDO,
      razonSocial: "Nueva SAC",
    });
    expect(llamada?.headers["x-csrf-token"]).toBe("csrf-acceso-1");
    await vi.waitFor(() =>
      expect(router.push).toHaveBeenCalledWith("/clientes/c-77"),
    );
  });

  it("sin razón social: el cuerpo omite razonSocial", async () => {
    const f = instalarFetchFalso(
      rutas(PUEDE, {
        "POST /api/clientes": {
          status: 201,
          cuerpo: clienteDe({ id: "c-78" }),
        },
      }),
    );
    render(<NuevoCliente />);
    const user = await escribir(RUC_VALIDO);
    await user.click(screen.getByRole("button", { name: "Crear cliente" }));
    await vi.waitFor(() => expect(f.de("POST /api/clientes")).toHaveLength(1));
    expect(f.de("POST /api/clientes")[0]?.body).toEqual({ ruc: RUC_VALIDO });
  });

  it("409 cupo_rucs: aviso de límite y uso del plan; no navega", async () => {
    const f = instalarFetchFalso(
      rutas(PUEDE, {
        "POST /api/clientes": { status: 409, cuerpo: { codigo: "cupo_rucs" } },
      }),
    );
    render(<NuevoCliente />);
    const user = await escribir(RUC_VALIDO);
    await user.click(screen.getByRole("button", { name: "Crear cliente" }));
    await vi.waitFor(() =>
      expect(
        screen.getAllByText(MENSAJES_PLANES.limiteRucs).length,
      ).toBeGreaterThan(0),
    );
    const uso = await screen.findByRole("region", { name: "Uso del plan" });
    expect(within(uso).getByText(/RUCs: 100 de 100/)).toBeTruthy();
    expect(f.de("GET /api/plan/uso").length).toBeGreaterThan(0);
    expect(router.push).not.toHaveBeenCalled();
  });

  it.each<[string, number, unknown, string]>([
    [
      "409 ruc_duplicado",
      409,
      { codigo: "ruc_duplicado" },
      MENSAJES_CLIENTES.rucDuplicado,
    ],
    ["409 sin_plan", 409, { codigo: "sin_plan" }, MENSAJES_PLANES.sinPlan],
    ["400", 400, { codigo: "validacion" }, MENSAJES_PLANES.solicitudInvalida],
    ["403", 403, { codigo: "prohibido" }, MENSAJES_ACCESO.sinPermiso],
  ])(
    "%s → mensaje propio, sin navegar",
    async (_n, status, cuerpo, mensaje) => {
      instalarFetchFalso(
        rutas(PUEDE, { "POST /api/clientes": { status, cuerpo } }),
      );
      render(<NuevoCliente />);
      const user = await escribir(RUC_VALIDO);
      await user.click(screen.getByRole("button", { name: "Crear cliente" }));
      expect((await screen.findAllByText(mensaje)).length).toBeGreaterThan(0);
      expect(router.push).not.toHaveBeenCalled();
    },
  );

  // D3 (T13): el select "Responsable" solo ofrece miembros activos con puedeSerResponsable(rol) (D18):
  // un rol `lectura` no puede ser responsable y el servidor lo rechazaría con 409 miembro_no_asignable.
  it("D3 · el select Responsable ofrece solo miembros activos que pueden ser responsables", async () => {
    const miembro = (usuarioId: string, rol: string, activo = true) => ({
      usuarioId,
      nombre: `Nombre ${usuarioId}`,
      correo: `${usuarioId}@e.test`,
      rol,
      activo,
      esYo: false,
    });
    instalarFetchFalso(
      rutas([...PUEDE, "clientes.asignar"], {
        "GET /api/usuarios": {
          status: 200,
          cuerpo: [
            miembro("u-dueno", "dueno"),
            miembro("u-admin", "admin"),
            miembro("u-con", "contador"),
            miembro("u-asi", "asistente"),
            miembro("u-lec", "lectura"),
            miembro("u-off", "contador", false),
          ],
        },
      }),
    );
    render(<NuevoCliente />);
    const select = (await screen.findByLabelText(
      "Responsable",
    )) as HTMLSelectElement;
    await vi.waitFor(() => expect(select.options.length).toBeGreaterThan(1));
    expect([...select.options].map((o) => o.value)).toEqual([
      "",
      "u-dueno",
      "u-admin",
      "u-con",
      "u-asi",
    ]);
  });
});

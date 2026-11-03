import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../../lib/sesion";
import { MENSAJES_ACCESO } from "../../../pruebas/acceso";
import { MENSAJES_PLANES } from "../../../pruebas/planes";
import {
  MENSAJES,
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
  usePathname: () => "/registro",
  useSearchParams: () => new URLSearchParams(),
}));

import Registro from "./page";

// Contrato (plan 006, HTTP; CA-3, CA-4, CA-10). Pantalla pública /registro: campos con etiqueta
// "Nombre del estudio", "RUC del estudio (opcional)", "Tu nombre" y "Correo"; botón "Crear estudio".
// No pide contraseña (se fija al confirmar). POST /api/registro { estudio, ruc?, nombre, correo } sin
// sesión (`sinSesion`: sin CSRF ni X-Estudio, sin GET /auth/sesion); `ruc` solo si se escribió y debe
// tener exactamente 11 dígitos (si no: MENSAJES_PLANES.rucInvalido, sin petición). Con 202 muestra
// SIEMPRE MENSAJES_PLANES.revisaCorreo, sin repetir el correo ni variar según la entrada (sin oráculo).
// 429 → MENSAJES.demasiadosIntentos; 400 → solicitudInvalida; otro → errorGeneral.

const CORREO = "dueno.nuevo@ejemplo.test";

async function llenar(
  campos: {
    estudio?: string;
    ruc?: string;
    nombre?: string;
    correo?: string;
  } = {},
) {
  const {
    estudio = "Estudio Gamma",
    ruc,
    nombre = "Gina Gamma",
    correo = CORREO,
  } = campos;
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Nombre del estudio"), estudio);
  if (ruc)
    await user.type(screen.getByLabelText("RUC del estudio (opcional)"), ruc);
  await user.type(screen.getByLabelText("Tu nombre"), nombre);
  await user.type(screen.getByLabelText("Correo"), correo);
  return user;
}

const enviar = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: "Crear estudio" }));

function rutas(registro: Manejador): Record<string, Manejador> {
  return { "POST /api/registro": registro };
}

describe("/registro", () => {
  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    reiniciarSesion();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("muestra los campos y el botón, y no pide contraseña", () => {
    instalarFetchFalso({});
    render(<Registro />);
    expect(screen.getByLabelText("Nombre del estudio")).toBeTruthy();
    expect(screen.getByLabelText("RUC del estudio (opcional)")).toBeTruthy();
    expect(screen.getByLabelText("Tu nombre")).toBeTruthy();
    expect(screen.getByLabelText("Correo")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Crear estudio" })).toBeTruthy();
    expect(screen.queryByLabelText("Contraseña")).toBeNull();
  });

  it("envía POST /api/registro { estudio, nombre, correo } sin ruc, sin sesión ni CSRF", async () => {
    const f = instalarFetchFalso(rutas({ status: 202, cuerpo: { ok: true } }));
    render(<Registro />);
    await enviar(await llenar());
    expect(await screen.findByText(MENSAJES_PLANES.revisaCorreo)).toBeTruthy();
    const [llamada] = f.de("POST /api/registro");
    expect(llamada?.body).toEqual({
      estudio: "Estudio Gamma",
      nombre: "Gina Gamma",
      correo: CORREO,
    });
    expect(llamada?.url).toBe("/api/registro");
    expect(llamada?.credentials).toBe("same-origin");
    expect(llamada?.headers["x-csrf-token"]).toBeUndefined();
    expect(llamada?.headers["x-estudio"]).toBeUndefined();
    expect(f.de("GET /api/auth/sesion")).toHaveLength(0);
  });

  it("con RUC de 11 dígitos lo envía en `ruc`", async () => {
    const f = instalarFetchFalso(rutas({ status: 202, cuerpo: { ok: true } }));
    render(<Registro />);
    await enviar(await llenar({ ruc: "20123456789" }));
    await screen.findByText(MENSAJES_PLANES.revisaCorreo);
    expect(f.de("POST /api/registro")[0]?.body).toEqual({
      estudio: "Estudio Gamma",
      ruc: "20123456789",
      nombre: "Gina Gamma",
      correo: CORREO,
    });
  });

  it.each(["2012345678", "201234567890", "2012345678A"])(
    "RUC inválido %s → mensaje y ninguna petición",
    async (ruc) => {
      const f = instalarFetchFalso(
        rutas({ status: 202, cuerpo: { ok: true } }),
      );
      render(<Registro />);
      await enviar(await llenar({ ruc }));
      expect(await screen.findByText(MENSAJES_PLANES.rucInvalido)).toBeTruthy();
      expect(f.llamadas).toHaveLength(0);
    },
  );

  it("con campos obligatorios vacíos no envía nada", async () => {
    const f = instalarFetchFalso(rutas({ status: 202, cuerpo: { ok: true } }));
    render(<Registro />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Correo"), CORREO);
    await enviar(user);
    expect(f.llamadas).toHaveLength(0);
    expect(screen.queryByText(MENSAJES_PLANES.revisaCorreo)).toBeNull();
  });

  it("202 → siempre el mismo mensaje, sin repetir el correo ni hacer otra petición", async () => {
    const f = instalarFetchFalso(rutas({ status: 202, cuerpo: { ok: true } }));
    const { container } = render(<Registro />);
    await enviar(await llenar());
    await screen.findByText(MENSAJES_PLANES.revisaCorreo);
    expect(container.textContent).not.toContain(CORREO);
    expect(f.llamadas).toHaveLength(1);
  });

  it("429 → mensaje de demasiados intentos", async () => {
    instalarFetchFalso(
      rutas({ status: 429, cuerpo: { codigo: "demasiados_intentos" } }),
    );
    render(<Registro />);
    await enviar(await llenar());
    expect(await screen.findByText(MENSAJES.demasiadosIntentos)).toBeTruthy();
    expect(screen.queryByText(MENSAJES_PLANES.revisaCorreo)).toBeNull();
  });

  it("400 solicitud_invalida → mensaje de revisión sin eco del servidor", async () => {
    instalarFetchFalso(
      rutas({
        status: 400,
        cuerpo: { codigo: "solicitud_invalida", detalle: "campo-interno-xyz" },
      }),
    );
    const { container } = render(<Registro />);
    await enviar(await llenar());
    expect(
      await screen.findByText(MENSAJES_PLANES.solicitudInvalida),
    ).toBeTruthy();
    expect(container.textContent).not.toContain("campo-interno-xyz");
  });

  it("500 → mensaje genérico", async () => {
    instalarFetchFalso(rutas({ status: 500, cuerpo: {} }));
    render(<Registro />);
    await enviar(await llenar());
    expect(await screen.findByText(MENSAJES_ACCESO.errorGeneral)).toBeTruthy();
  });
});

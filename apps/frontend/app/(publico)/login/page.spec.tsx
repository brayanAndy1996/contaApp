import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../../lib/sesion";
import {
  MENSAJES,
  crearRouterFalso,
  destinos,
  instalarFetchFalso,
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
  usePathname: () => "/login",
  useSearchParams: () => new URLSearchParams(),
}));

import Login from "./page";

// Contrato (plan 004, Frontend; CA-12, P3, P7). Pantalla /login: campos con etiqueta "Correo" y
// "Contraseña", botón "Ingresar". POST /api/auth/login { correo, contrasena } sin sesión previa
// (`api(..., { sinSesion: true })`). 401 (cualquier causa, incluido el bloqueo) → un único mensaje;
// 429 → otro. 200: con estudioActivo → "/"; sin estudioActivo (varios o ninguno) → "/estudios"
// (allí se resalta el último usado o se muestra "No perteneces a ningún estudio activo").

const CORREO = "ana@ejemplo.test";
const CONTRASENA = "canario-contrasena-de-prueba-1";

async function enviar(correo = CORREO, contrasena = CONTRASENA) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Correo"), correo);
  await user.type(screen.getByLabelText("Contraseña"), contrasena);
  await user.click(screen.getByRole("button", { name: "Ingresar" }));
}

describe("/login", () => {
  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    try {
      reiniciarSesion();
    } catch {
      // stub rojo
    }
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("muestra los campos Correo y Contraseña (este último de tipo password) y el botón Ingresar", () => {
    render(<Login />);
    expect(screen.getByLabelText("Correo")).toBeTruthy();
    const contrasena = screen.getByLabelText("Contraseña");
    expect(contrasena.getAttribute("type")).toBe("password");
    expect(screen.getByRole("button", { name: "Ingresar" })).toBeTruthy();
  });

  it("envía POST /api/auth/login con correo y contrasena, mismo origen y sin cabeceras de sesión", async () => {
    const f = instalarFetchFalso({
      "POST /api/auth/login": {
        status: 200,
        cuerpo: {
          estudioActivo: { id: "e-1", nombre: "Estudio Uno" },
          requiereEstudio: false,
        },
      },
    });
    render(<Login />);
    await enviar();
    await vi.waitFor(() =>
      expect(f.de("POST /api/auth/login")).toHaveLength(1),
    );
    const [llamada] = f.de("POST /api/auth/login");
    expect(llamada?.body).toEqual({ correo: CORREO, contrasena: CONTRASENA });
    expect(llamada?.credentials).toBe("same-origin");
    expect(llamada?.headers["x-csrf-token"]).toBeUndefined();
    expect(llamada?.url).toBe("/api/auth/login");
  });

  it("401 credenciales_invalidas → mensaje genérico y no navega", async () => {
    instalarFetchFalso({
      "POST /api/auth/login": {
        status: 401,
        cuerpo: { codigo: "credenciales_invalidas" },
      },
    });
    render(<Login />);
    await enviar();
    expect(
      await screen.findByText(MENSAJES.credencialesInvalidas),
    ).toBeTruthy();
    expect(destinos(router)).toEqual([]);
  });

  it("401 con cualquier otro código o cuerpo (p. ej. cuenta bloqueada) → exactamente el mismo mensaje (P3)", async () => {
    const mensajes: string[] = [];
    for (const cuerpo of [
      { codigo: "cuenta_bloqueada" },
      { codigo: "usuario_inexistente" },
      {},
    ]) {
      instalarFetchFalso({ "POST /api/auth/login": { status: 401, cuerpo } });
      const { container, unmount } = render(<Login />);
      await enviar();
      await screen.findByText(MENSAJES.credencialesInvalidas);
      mensajes.push(
        screen.getByText(MENSAJES.credencialesInvalidas).textContent ?? "",
      );
      expect(container.textContent).not.toContain("bloquead");
      expect(container.textContent).not.toContain("inexistente");
      unmount();
      vi.unstubAllGlobals();
    }
    expect(new Set(mensajes)).toEqual(
      new Set([MENSAJES.credencialesInvalidas]),
    );
  });

  it("429 demasiados_intentos → otro mensaje, distinto del de credenciales inválidas", async () => {
    instalarFetchFalso({
      "POST /api/auth/login": {
        status: 429,
        cuerpo: { codigo: "demasiados_intentos" },
      },
    });
    render(<Login />);
    await enviar();
    expect(await screen.findByText(MENSAJES.demasiadosIntentos)).toBeTruthy();
    expect(screen.queryByText(MENSAJES.credencialesInvalidas)).toBeNull();
    expect(MENSAJES.demasiadosIntentos).not.toBe(
      MENSAJES.credencialesInvalidas,
    );
  });

  it("200 con un estudio activo → va a /", async () => {
    instalarFetchFalso({
      "POST /api/auth/login": {
        status: 200,
        cuerpo: {
          estudioActivo: { id: "e-1", nombre: "Estudio Uno" },
          requiereEstudio: false,
        },
      },
    });
    render(<Login />);
    await enviar();
    await vi.waitFor(() => expect(destinos(router)).toEqual(["/"]));
  });

  it("200 sin estudio activo y requiereEstudio (varios estudios) → va a /estudios", async () => {
    instalarFetchFalso({
      "POST /api/auth/login": {
        status: 200,
        cuerpo: { estudioActivo: null, requiereEstudio: true },
      },
    });
    render(<Login />);
    await enviar();
    await vi.waitFor(() => expect(destinos(router)).toEqual(["/estudios"]));
  });

  it("200 sin estudio activo ni estudios (usuario sin membresías) → va a /estudios, que muestra el aviso", async () => {
    instalarFetchFalso({
      "POST /api/auth/login": {
        status: 200,
        cuerpo: { estudioActivo: null, requiereEstudio: false },
      },
    });
    render(<Login />);
    await enviar();
    await vi.waitFor(() => expect(destinos(router)).toEqual(["/estudios"]));
  });

  it("no escribe la contraseña ni el correo en la consola", async () => {
    const espias = (["log", "info", "warn", "error", "debug"] as const).map(
      (m) => vi.spyOn(console, m).mockImplementation(() => {}),
    );
    instalarFetchFalso({
      "POST /api/auth/login": {
        status: 401,
        cuerpo: { codigo: "credenciales_invalidas" },
      },
    });
    render(<Login />);
    await enviar();
    await screen.findByText(MENSAJES.credencialesInvalidas);
    const visto = JSON.stringify(espias.flatMap((e) => e.mock.calls));
    expect(visto).not.toContain(CONTRASENA);
  });
});

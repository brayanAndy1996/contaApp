import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../../../lib/sesion";
import {
  MENSAJES,
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
  usePathname: () => "/recuperar/nueva",
  useSearchParams: () => new URLSearchParams(),
}));

import Nueva from "./page";

// Contrato (plan 004, Frontend; CA-8, CA-12). Pantalla /recuperar/nueva: el token viaja en el
// fragmento `#t=<token>` (nunca llega al servidor ni a Referer). Al montar lo lee, lo guarda en
// memoria y borra el fragmento con history.replaceState. Campo "Nueva contraseña", botón "Cambiar
// contraseña". POST /api/auth/recuperar/restablecer { token, contrasena } sin sesión; el token no
// aparece en la URL de la petición, en cabeceras, en location ni en la consola.
// 204 → MENSAJES.contrasenaActualizada y enlace "Ir a iniciar sesión" a /login.
// 400 contrasena_invalida (motivo longitud | comun) y 400 token_invalido → su mensaje.
// Sin fragmento → MENSAJES.tokenInvalido al montar y ninguna petición.

const TOKEN = "TokenCanarioDeRecuperacion_0123456789abcdefghijk";
const CONTRASENA = "canario-contrasena-nueva-123";

async function cambiar(contrasena = CONTRASENA) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Nueva contraseña"), contrasena);
  await user.click(screen.getByRole("button", { name: "Cambiar contraseña" }));
}

describe("/recuperar/nueva", () => {
  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    window.history.replaceState(null, "", `/recuperar/nueva#t=${TOKEN}`);
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
    window.history.replaceState(null, "", "/");
  });

  it("al montar borra el fragmento de la URL con history.replaceState", async () => {
    const espia = vi.spyOn(window.history, "replaceState");
    render(<Nueva />);
    await vi.waitFor(() => expect(espia).toHaveBeenCalled());
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(TOKEN);
    expect(window.location.pathname).toBe("/recuperar/nueva");
  });

  it("envía el token leído del fragmento y la contraseña por POST, sin sesión", async () => {
    const f = instalarFetchFalso({
      "POST /api/auth/recuperar/restablecer": { status: 204 },
    });
    render(<Nueva />);
    await cambiar();
    await vi.waitFor(() => expect(f.llamadas).toHaveLength(1));
    const [llamada] = f.de("POST /api/auth/recuperar/restablecer");
    expect(llamada?.body).toEqual({ token: TOKEN, contrasena: CONTRASENA });
    expect(llamada?.credentials).toBe("same-origin");
    expect(llamada?.headers["x-csrf-token"]).toBeUndefined();
  });

  it("204 → mensaje de éxito y enlace a /login", async () => {
    instalarFetchFalso({
      "POST /api/auth/recuperar/restablecer": { status: 204 },
    });
    render(<Nueva />);
    await cambiar();
    expect(
      await screen.findByText(MENSAJES.contrasenaActualizada),
    ).toBeTruthy();
    const enlace = screen.getByRole("link", { name: "Ir a iniciar sesión" });
    expect(enlace.getAttribute("href")).toBe("/login");
  });

  it("el token no aparece en la URL de la petición, en cabeceras, en location ni en la consola", async () => {
    const espias = (["log", "info", "warn", "error", "debug"] as const).map(
      (m) => vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const f = instalarFetchFalso({
      "POST /api/auth/recuperar/restablecer": {
        status: 400,
        cuerpo: { codigo: "token_invalido" },
      },
    });
    const { container } = render(<Nueva />);
    await cambiar();
    await screen.findByText(MENSAJES.tokenInvalido);
    const [llamada] = f.de("POST /api/auth/recuperar/restablecer");
    expect(llamada?.url).toBe("/api/auth/recuperar/restablecer");
    expect(llamada?.url).not.toContain(TOKEN);
    expect(JSON.stringify(llamada?.headers)).not.toContain(TOKEN);
    expect(window.location.href).not.toContain(TOKEN);
    expect(container.innerHTML).not.toContain(TOKEN);
    expect(JSON.stringify(espias.flatMap((e) => e.mock.calls))).not.toContain(
      TOKEN,
    );
  });

  it("400 contrasena_invalida con motivo longitud → mensaje de longitud", async () => {
    instalarFetchFalso({
      "POST /api/auth/recuperar/restablecer": {
        status: 400,
        cuerpo: { codigo: "contrasena_invalida", motivo: "longitud" },
      },
    });
    render(<Nueva />);
    await cambiar("corta");
    expect(await screen.findByText(MENSAJES.contrasenaLongitud)).toBeTruthy();
  });

  it("400 contrasena_invalida con motivo comun → mensaje de contraseña común", async () => {
    instalarFetchFalso({
      "POST /api/auth/recuperar/restablecer": {
        status: 400,
        cuerpo: { codigo: "contrasena_invalida", motivo: "comun" },
      },
    });
    render(<Nueva />);
    await cambiar("contrasena-comun-123");
    expect(await screen.findByText(MENSAJES.contrasenaComun)).toBeTruthy();
  });

  it("400 token_invalido → mensaje de enlace inválido o vencido", async () => {
    instalarFetchFalso({
      "POST /api/auth/recuperar/restablecer": {
        status: 400,
        cuerpo: { codigo: "token_invalido" },
      },
    });
    render(<Nueva />);
    await cambiar();
    expect(await screen.findByText(MENSAJES.tokenInvalido)).toBeTruthy();
  });

  it("tras un 400 por contraseña, el reintento sigue enviando el mismo token (guardado en memoria)", async () => {
    const f = instalarFetchFalso({
      "POST /api/auth/recuperar/restablecer": (_l, vez) =>
        vez === 1
          ? {
              status: 400,
              cuerpo: { codigo: "contrasena_invalida", motivo: "longitud" },
            }
          : { status: 204 },
    });
    render(<Nueva />);
    await cambiar("corta");
    await screen.findByText(MENSAJES.contrasenaLongitud);
    expect(window.location.hash).toBe("");
    const user = userEvent.setup();
    const campo = screen.getByLabelText("Nueva contraseña");
    await user.clear(campo);
    await user.type(campo, CONTRASENA);
    await user.click(
      screen.getByRole("button", { name: "Cambiar contraseña" }),
    );
    await screen.findByText(MENSAJES.contrasenaActualizada);
    const posts = f.de("POST /api/auth/recuperar/restablecer");
    expect(posts).toHaveLength(2);
    expect(posts[1]?.body).toEqual({ token: TOKEN, contrasena: CONTRASENA });
  });

  it("sin fragmento #t= muestra el mensaje de enlace inválido y no hace ninguna petición", async () => {
    window.history.replaceState(null, "", "/recuperar/nueva");
    const f = instalarFetchFalso({});
    render(<Nueva />);
    expect(await screen.findByText(MENSAJES.tokenInvalido)).toBeTruthy();
    expect(f.llamadas).toHaveLength(0);
  });
});

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../../../lib/sesion";
import {
  MENSAJES,
  crearRouterFalso,
  destinos,
  instalarFetchFalso,
  sesionDe,
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
  usePathname: () => "/cuenta/contrasena",
  useSearchParams: () => new URLSearchParams(),
}));

import CambioContrasena from "./page";

// Contrato (spec 004, P11 y CA-4; plan 004, Backend/Frontend). Pantalla /cuenta/contrasena dentro de
// (app): campos "Contraseña actual" y "Nueva contraseña" (type=password) y botón "Cambiar
// contraseña". POST /api/auth/contrasena { actual, nueva } con sesión: lleva X-CSRF-Token y
// X-Estudio (los pone `api()`), credentials same-origin y la URL sin datos. Sin validación de la
// política en el cliente: la decide el servidor (también se envía "corta").
//   204 (cookie rotada) → se vuelve a leer GET /api/auth/sesion y se muestra
//        MENSAJES.contrasenaActualizada.
//   401 (la actual es incorrecta) → MENSAJES.actualIncorrecta; NO se trata como sesión caducada:
//        no navega a /login.
//   400 contrasena_invalida motivo longitud | comun → MENSAJES.contrasenaLongitud | contrasenaComun.
// Las contraseñas no aparecen en la URL, en cabeceras, en location ni en la consola.

const ESTUDIO = { id: "e-1", nombre: "Estudio Uno" };
const ACTUAL = "canario-contrasena-actual-123";
const NUEVA = "canario-contrasena-nueva-456";
const RUTA = "POST /api/auth/contrasena";

/** Rutas base: la sesión (con csrf distinto en cada lectura) y la del cambio. */
function rutas(cambio: Parameters<typeof instalarFetchFalso>[0][string]) {
  return {
    "GET /api/auth/sesion": (_l: unknown, vez: number) => ({
      status: 200,
      cuerpo: sesionDe(ESTUDIO, `csrf-canario-${vez}`),
    }),
    [RUTA]: cambio,
  };
}

async function cambiar(actual = ACTUAL, nueva = NUEVA) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Contraseña actual"), actual);
  await user.type(screen.getByLabelText("Nueva contraseña"), nueva);
  await user.click(screen.getByRole("button", { name: "Cambiar contraseña" }));
}

const MENSAJES_DEL_FORMULARIO = [
  MENSAJES.contrasenaActualizada,
  MENSAJES.actualIncorrecta,
  MENSAJES.contrasenaLongitud,
  MENSAJES.contrasenaComun,
];

describe("/cuenta/contrasena (P11)", () => {
  let asignar: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    reiniciarSesion();
    // `api()` va a /login con window.location.assign ante un 401: se vigila sin navegar de verdad.
    asignar = vi.fn();
    vi.stubGlobal("location", {
      ...window.location,
      pathname: "/cuenta/contrasena",
      assign: asignar,
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("muestra los campos 'Contraseña actual' y 'Nueva contraseña' de tipo password y el botón 'Cambiar contraseña'", () => {
    instalarFetchFalso(rutas({ status: 204 }));
    render(<CambioContrasena />);
    for (const etiqueta of ["Contraseña actual", "Nueva contraseña"]) {
      const campo = screen.getByLabelText(etiqueta);
      expect(campo.tagName).toBe("INPUT");
      expect(campo.getAttribute("type")).toBe("password");
    }
    expect(screen.getByRole("button", { name: "Cambiar contraseña" })).toBeTruthy();
  });

  it("envía POST /api/auth/contrasena { actual, nueva } con X-CSRF-Token y X-Estudio de la sesión", async () => {
    const f = instalarFetchFalso(rutas({ status: 204 }));
    render(<CambioContrasena />);
    await cambiar();
    await vi.waitFor(() => expect(f.de(RUTA)).toHaveLength(1));
    const [llamada] = f.de(RUTA);
    expect(llamada?.body).toEqual({ actual: ACTUAL, nueva: NUEVA });
    expect(llamada?.credentials).toBe("same-origin");
    expect(llamada?.headers["x-csrf-token"]).toBe("csrf-canario-1");
    expect(llamada?.headers["x-estudio"]).toBe(ESTUDIO.id);
    expect(llamada?.headers["content-type"]).toBe("application/json");
  });

  it("204 → muestra el texto de éxito y vuelve a leer la sesión después del cambio (cookie rotada)", async () => {
    const f = instalarFetchFalso(rutas({ status: 204 }));
    render(<CambioContrasena />);
    await cambiar();
    expect(await screen.findByText(MENSAJES.contrasenaActualizada)).toBeTruthy();
    const post = f.llamadas.findIndex((l) => `${l.method} ${l.ruta}` === RUTA);
    const lecturasPosteriores = f.llamadas
      .slice(post + 1)
      .filter((l) => `${l.method} ${l.ruta}` === "GET /api/auth/sesion");
    expect(post).toBeGreaterThan(-1);
    expect(lecturasPosteriores.length).toBeGreaterThanOrEqual(1);
    // Éxito no mezclado con ningún mensaje de error.
    for (const error of [
      MENSAJES.actualIncorrecta,
      MENSAJES.contrasenaLongitud,
      MENSAJES.contrasenaComun,
    ]) {
      expect(screen.queryByText(error)).toBeNull();
    }
    expect(destinos(router)).not.toContain("/login");
  });

  it("401 (actual incorrecta) → mensaje propio, sin ir a /login ni mostrar éxito", async () => {
    instalarFetchFalso(rutas({ status: 401, cuerpo: { codigo: "no_autenticado" } }));
    render(<CambioContrasena />);
    await cambiar("no-es-la-actual-Zz9-canario");
    expect(await screen.findByText(MENSAJES.actualIncorrecta)).toBeTruthy();
    expect(screen.queryByText(MENSAJES.contrasenaActualizada)).toBeNull();
    expect(destinos(router)).not.toContain("/login");
    expect(asignar).not.toHaveBeenCalled();
  });

  it("400 contrasena_invalida con motivo longitud → mensaje de longitud", async () => {
    instalarFetchFalso(
      rutas({
        status: 400,
        cuerpo: { codigo: "contrasena_invalida", motivo: "longitud" },
      }),
    );
    render(<CambioContrasena />);
    await cambiar(ACTUAL, "corta");
    expect(await screen.findByText(MENSAJES.contrasenaLongitud)).toBeTruthy();
    expect(screen.queryByText(MENSAJES.contrasenaComun)).toBeNull();
    expect(screen.queryByText(MENSAJES.contrasenaActualizada)).toBeNull();
  });

  it("400 contrasena_invalida con motivo comun → mensaje de contraseña común", async () => {
    instalarFetchFalso(
      rutas({
        status: 400,
        cuerpo: { codigo: "contrasena_invalida", motivo: "comun" },
      }),
    );
    render(<CambioContrasena />);
    await cambiar(ACTUAL, "contrasena-comun-123");
    expect(await screen.findByText(MENSAJES.contrasenaComun)).toBeTruthy();
    expect(screen.queryByText(MENSAJES.contrasenaLongitud)).toBeNull();
    expect(screen.queryByText(MENSAJES.contrasenaActualizada)).toBeNull();
  });

  it("los mensajes de actual incorrecta, longitud y común son distintos entre sí y del de éxito", () => {
    expect(new Set(MENSAJES_DEL_FORMULARIO).size).toBe(
      MENSAJES_DEL_FORMULARIO.length,
    );
  });

  it("no valida la política en el cliente: una contraseña nueva de 5 caracteres igual se envía al servidor", async () => {
    const f = instalarFetchFalso(
      rutas({
        status: 400,
        cuerpo: { codigo: "contrasena_invalida", motivo: "longitud" },
      }),
    );
    render(<CambioContrasena />);
    await cambiar(ACTUAL, "corta");
    await screen.findByText(MENSAJES.contrasenaLongitud);
    const [llamada] = f.de(RUTA);
    expect(llamada?.body).toEqual({ actual: ACTUAL, nueva: "corta" });
  });

  it("tras un error, el reintento vuelve a enviar el formulario y el 204 muestra el éxito", async () => {
    const f = instalarFetchFalso(
      rutas((_l, vez) =>
        vez === 1
          ? {
              status: 400,
              cuerpo: { codigo: "contrasena_invalida", motivo: "longitud" },
            }
          : { status: 204 },
      ),
    );
    render(<CambioContrasena />);
    await cambiar(ACTUAL, "corta");
    await screen.findByText(MENSAJES.contrasenaLongitud);
    const user = userEvent.setup();
    const campo = screen.getByLabelText("Nueva contraseña");
    await user.clear(campo);
    await user.type(campo, NUEVA);
    await user.click(screen.getByRole("button", { name: "Cambiar contraseña" }));
    expect(await screen.findByText(MENSAJES.contrasenaActualizada)).toBeTruthy();
    const posts = f.de(RUTA);
    expect(posts).toHaveLength(2);
    expect(posts[1]?.body).toEqual({ actual: ACTUAL, nueva: NUEVA });
    expect(screen.queryByText(MENSAJES.contrasenaLongitud)).toBeNull();
  });

  it("las contraseñas no aparecen en la URL de la petición, cabeceras, location, DOM ni consola", async () => {
    const espias = (["log", "info", "warn", "error", "debug"] as const).map(
      (m) => vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const f = instalarFetchFalso(
      rutas({
        status: 400,
        cuerpo: { codigo: "contrasena_invalida", motivo: "comun" },
      }),
    );
    const { container } = render(<CambioContrasena />);
    await cambiar();
    await screen.findByText(MENSAJES.contrasenaComun);
    const [llamada] = f.de(RUTA);
    expect(llamada?.url).toBe("/api/auth/contrasena");
    const consola = JSON.stringify(espias.flatMap((e) => e.mock.calls));
    for (const secreto of [ACTUAL, NUEVA]) {
      expect(llamada?.url).not.toContain(secreto);
      expect(JSON.stringify(llamada?.headers)).not.toContain(secreto);
      expect(window.location.href).not.toContain(secreto);
      expect(container.innerHTML).not.toContain(secreto);
      expect(consola).not.toContain(secreto);
    }
  });
});

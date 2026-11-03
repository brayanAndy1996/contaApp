import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../../../lib/sesion";
import { MENSAJES_PLANES } from "../../../../pruebas/planes";
import {
  MENSAJES,
  crearRouterFalso,
  destinos,
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
  usePathname: () => "/registro/confirmar",
  useSearchParams: () => new URLSearchParams(),
}));

import ConfirmarRegistro from "./page";

// Contrato (plan 006, HTTP; CA-3, CA-4, CA-10). Pantalla /registro/confirmar: como /invitacion (005),
// el token viaja en el fragmento `#t=<token>`; al montar lo lee, lo guarda solo en memoria y borra el
// fragmento con history.replaceState; nunca aparece en URL de petición, cabeceras, location, DOM ni
// consola (solo en el cuerpo JSON de los POST).
// - Sin fragmento → MENSAJES_PLANES.registroInvalido y ninguna petición.
// - POST /api/registro/consultar { token } sin sesión → { estudio:{nombre}, correo, cuentaExiste }.
//   400 registro_invalido → registroInvalido y sin formulario ni botones.
// - cuentaExiste = false: muestra estudio y correo (solo texto), campo "Contraseña" (password) y botón
//   "Confirmar y crear estudio". Valida 12–128 caracteres antes de enviar (si no:
//   MENSAJES.contrasenaLongitud, sin petición). POST /api/registro/confirmar { token, contrasena } sin
//   sesión: 204 → MENSAJES_PLANES.registroCreado y enlace "Ir a iniciar sesión" a /login (sin
//   auto-login); 400 contrasena_invalida (motivo longitud | comun) → mensaje de 004; 400
//   registro_invalido → registroInvalido; 503 registro_no_disponible → registroNoDisponible;
//   409 requiere_sesion → pasa al modo de abajo sin perder el token.
// - cuentaExiste = true: muestra el correo (solo texto), campo "Contraseña" y botón "Iniciar sesión y
//   crear estudio". POST /api/auth/login { correo (el del registro), contrasena } sin sesión; 401 →
//   MENSAJES.credencialesInvalidas. Con 200: reinicia la sesión y POST /api/registro/confirmar-con-sesion
//   { token } con X-CSRF-Token de la sesión nueva (no llama a /registro/confirmar). 200 { estudio:{id,
//   nombre} } → MENSAJES_PLANES.estudioCreado(nombre) y botón "Cambiar a este estudio" (POST
//   /api/auth/estudio { tenantId: id } con CSRF → reinicia la sesión y va a "/"). 400 registro_invalido
//   → registroInvalido.

const TOKEN = "TokenCanarioDeRegistro_0123456789abcdefghijklmnopq";
const CORREO = "dueno.nuevo@ejemplo.test";
const CONTRASENA = "canario-contrasena-registro-123";
const NUEVA = {
  estudio: { nombre: "Estudio Gamma" },
  correo: CORREO,
  cuentaExiste: false,
};
const EXISTENTE = { ...NUEVA, cuentaExiste: true };
const LOGIN_OK: Manejador = {
  status: 200,
  cuerpo: { estudioActivo: null, requiereEstudio: false },
};

function rutas(
  consulta: Manejador,
  extra: Record<string, Manejador> = {},
): Record<string, Manejador> {
  return {
    "POST /api/registro/consultar": consulta,
    "GET /api/auth/sesion": {
      status: 200,
      cuerpo: sesionDe(null, "csrf-registro"),
    },
    ...extra,
  };
}

async function confirmar(contrasena = CONTRASENA) {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("Contraseña"), contrasena);
  await user.click(
    screen.getByRole("button", { name: "Confirmar y crear estudio" }),
  );
  return user;
}

async function iniciarSesion(contrasena = CONTRASENA) {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("Contraseña"), contrasena);
  await user.click(
    screen.getByRole("button", { name: "Iniciar sesión y crear estudio" }),
  );
  return user;
}

function espiarConsola() {
  return (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  );
}

describe("/registro/confirmar", () => {
  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    window.history.replaceState(null, "", `/registro/confirmar#t=${TOKEN}`);
    reiniciarSesion();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
  });

  it("al montar borra el fragmento de la URL con history.replaceState", async () => {
    instalarFetchFalso(rutas({ status: 200, cuerpo: NUEVA }));
    const espia = vi.spyOn(window.history, "replaceState");
    render(<ConfirmarRegistro />);
    await vi.waitFor(() => expect(espia).toHaveBeenCalled());
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(TOKEN);
    expect(window.location.pathname).toBe("/registro/confirmar");
  });

  it("consulta con POST /api/registro/consultar { token }, sin sesión, y muestra estudio y correo", async () => {
    const f = instalarFetchFalso(rutas({ status: 200, cuerpo: NUEVA }));
    const { container } = render(<ConfirmarRegistro />);
    await screen.findByLabelText("Contraseña");
    expect(container.textContent).toContain("Estudio Gamma");
    expect(container.textContent).toContain(CORREO);
    expect(screen.queryByLabelText("Correo")).toBeNull();
    expect(screen.queryByDisplayValue(CORREO)).toBeNull();
    const [llamada] = f.de("POST /api/registro/consultar");
    expect(llamada?.body).toEqual({ token: TOKEN });
    expect(llamada?.url).toBe("/api/registro/consultar");
    expect(llamada?.credentials).toBe("same-origin");
    expect(llamada?.headers["x-csrf-token"]).toBeUndefined();
    expect(llamada?.headers["x-estudio"]).toBeUndefined();
    expect(f.de("GET /api/auth/sesion")).toHaveLength(0);
  });

  it("sin fragmento #t= muestra registro inválido y no hace ninguna petición", async () => {
    window.history.replaceState(null, "", "/registro/confirmar");
    const f = instalarFetchFalso({});
    render(<ConfirmarRegistro />);
    expect(
      await screen.findByText(MENSAJES_PLANES.registroInvalido),
    ).toBeTruthy();
    expect(f.llamadas).toHaveLength(0);
  });

  it("consultar 400 registro_invalido → mensaje genérico y sin formulario", async () => {
    instalarFetchFalso(
      rutas({ status: 400, cuerpo: { codigo: "registro_invalido" } }),
    );
    render(<ConfirmarRegistro />);
    expect(
      await screen.findByText(MENSAJES_PLANES.registroInvalido),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Contraseña")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("la contraseña es de tipo password", async () => {
    instalarFetchFalso(rutas({ status: 200, cuerpo: NUEVA }));
    render(<ConfirmarRegistro />);
    expect(
      (await screen.findByLabelText("Contraseña")).getAttribute("type"),
    ).toBe("password");
  });

  it("204 → registro creado y enlace a /login, sin auto-login", async () => {
    const f = instalarFetchFalso(
      rutas(
        { status: 200, cuerpo: NUEVA },
        { "POST /api/registro/confirmar": { status: 204 } },
      ),
    );
    render(<ConfirmarRegistro />);
    await confirmar();
    expect(
      await screen.findByText(MENSAJES_PLANES.registroCreado),
    ).toBeTruthy();
    const enlace = screen.getByRole("link", { name: "Ir a iniciar sesión" });
    expect(enlace.getAttribute("href")).toBe("/login");
    const [llamada] = f.de("POST /api/registro/confirmar");
    expect(llamada?.body).toEqual({ token: TOKEN, contrasena: CONTRASENA });
    expect(llamada?.credentials).toBe("same-origin");
    expect(llamada?.headers["x-csrf-token"]).toBeUndefined();
    expect(f.de("POST /api/auth/login")).toHaveLength(0);
  });

  it.each([11, 129])(
    "contraseña de %i caracteres → mensaje de longitud y no envía la confirmación",
    async (n) => {
      const f = instalarFetchFalso(rutas({ status: 200, cuerpo: NUEVA }));
      render(<ConfirmarRegistro />);
      const user = userEvent.setup();
      await user.click(await screen.findByLabelText("Contraseña"));
      await user.paste("A".repeat(n));
      await user.click(
        screen.getByRole("button", { name: "Confirmar y crear estudio" }),
      );
      expect(await screen.findByText(MENSAJES.contrasenaLongitud)).toBeTruthy();
      expect(f.de("POST /api/registro/confirmar")).toHaveLength(0);
    },
  );

  it("400 contrasena_invalida comun → motivo visible, y el reintento reutiliza el mismo token", async () => {
    const f = instalarFetchFalso(
      rutas(
        { status: 200, cuerpo: NUEVA },
        {
          "POST /api/registro/confirmar": (_l, vez) =>
            vez === 1
              ? {
                  status: 400,
                  cuerpo: { codigo: "contrasena_invalida", motivo: "comun" },
                }
              : { status: 204 },
        },
      ),
    );
    render(<ConfirmarRegistro />);
    const user = await confirmar("contrasena-comun-123");
    expect(await screen.findByText(MENSAJES.contrasenaComun)).toBeTruthy();
    const campo = screen.getByLabelText("Contraseña");
    await user.clear(campo);
    await user.type(campo, CONTRASENA);
    await user.click(
      screen.getByRole("button", { name: "Confirmar y crear estudio" }),
    );
    await screen.findByText(MENSAJES_PLANES.registroCreado);
    const posts = f.de("POST /api/registro/confirmar");
    expect(posts).toHaveLength(2);
    expect(posts[1]?.body).toEqual({ token: TOKEN, contrasena: CONTRASENA });
  });

  it("400 contrasena_invalida longitud (servidor) → mensaje de longitud", async () => {
    instalarFetchFalso(
      rutas(
        { status: 200, cuerpo: NUEVA },
        {
          "POST /api/registro/confirmar": {
            status: 400,
            cuerpo: { codigo: "contrasena_invalida", motivo: "longitud" },
          },
        },
      ),
    );
    render(<ConfirmarRegistro />);
    await confirmar();
    expect(await screen.findByText(MENSAJES.contrasenaLongitud)).toBeTruthy();
  });

  it("400 registro_invalido al confirmar → mensaje genérico", async () => {
    instalarFetchFalso(
      rutas(
        { status: 200, cuerpo: NUEVA },
        {
          "POST /api/registro/confirmar": {
            status: 400,
            cuerpo: { codigo: "registro_invalido" },
          },
        },
      ),
    );
    render(<ConfirmarRegistro />);
    await confirmar();
    expect(
      await screen.findByText(MENSAJES_PLANES.registroInvalido),
    ).toBeTruthy();
  });

  it("503 registro_no_disponible → mensaje de no disponible", async () => {
    instalarFetchFalso(
      rutas(
        { status: 200, cuerpo: NUEVA },
        {
          "POST /api/registro/confirmar": {
            status: 503,
            cuerpo: { codigo: "registro_no_disponible" },
          },
        },
      ),
    );
    render(<ConfirmarRegistro />);
    await confirmar();
    expect(
      await screen.findByText(MENSAJES_PLANES.registroNoDisponible),
    ).toBeTruthy();
  });

  it("409 requiere_sesion → pasa a iniciar sesión sin perder el token, y crea el estudio con la sesión", async () => {
    const f = instalarFetchFalso(
      rutas(
        { status: 200, cuerpo: NUEVA },
        {
          "POST /api/registro/confirmar": {
            status: 409,
            cuerpo: { codigo: "requiere_sesion" },
          },
          "POST /api/auth/login": LOGIN_OK,
          "POST /api/registro/confirmar-con-sesion": {
            status: 200,
            cuerpo: { estudio: { id: "e-nuevo", nombre: "Estudio Gamma" } },
          },
        },
      ),
    );
    render(<ConfirmarRegistro />);
    await confirmar();
    expect(
      await screen.findByRole("button", {
        name: "Iniciar sesión y crear estudio",
      }),
    ).toBeTruthy();
    await iniciarSesion();
    await screen.findByText(MENSAJES_PLANES.estudioCreado("Estudio Gamma"));
    expect(f.de("POST /api/registro/confirmar-con-sesion")[0]?.body).toEqual({
      token: TOKEN,
    });
  });

  it("cuenta existente: correo fijo, login con ese correo y luego confirmar-con-sesion con el CSRF de la sesión nueva", async () => {
    const f = instalarFetchFalso(
      rutas(
        { status: 200, cuerpo: EXISTENTE },
        {
          "POST /api/auth/login": LOGIN_OK,
          "POST /api/registro/confirmar-con-sesion": {
            status: 200,
            cuerpo: { estudio: { id: "e-nuevo", nombre: "Estudio Gamma" } },
          },
        },
      ),
    );
    const { container } = render(<ConfirmarRegistro />);
    expect(
      await screen.findByRole("button", {
        name: "Iniciar sesión y crear estudio",
      }),
    ).toBeTruthy();
    expect(container.textContent).toContain(CORREO);
    expect(screen.queryByLabelText("Correo")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Confirmar y crear estudio" }),
    ).toBeNull();
    await iniciarSesion();
    expect(
      await screen.findByText(MENSAJES_PLANES.estudioCreado("Estudio Gamma")),
    ).toBeTruthy();
    const [login] = f.de("POST /api/auth/login");
    expect(login?.body).toEqual({ correo: CORREO, contrasena: CONTRASENA });
    expect(login?.headers["x-csrf-token"]).toBeUndefined();
    const [crear] = f.de("POST /api/registro/confirmar-con-sesion");
    expect(crear?.body).toEqual({ token: TOKEN });
    expect(crear?.headers["x-csrf-token"]).toBe("csrf-registro");
    expect(crear?.headers["x-estudio"]).toBeUndefined();
    expect(f.de("POST /api/registro/confirmar")).toHaveLength(0);
    const orden = f.llamadas.map((l) => `${l.method} ${l.ruta}`);
    expect(orden.indexOf("POST /api/auth/login")).toBeLessThan(
      orden.indexOf("POST /api/registro/confirmar-con-sesion"),
    );
  });

  it("cuenta existente: login 401 → mensaje genérico y no intenta crear el estudio", async () => {
    const f = instalarFetchFalso(
      rutas(
        { status: 200, cuerpo: EXISTENTE },
        {
          "POST /api/auth/login": {
            status: 401,
            cuerpo: { codigo: "credenciales_invalidas" },
          },
        },
      ),
    );
    render(<ConfirmarRegistro />);
    await iniciarSesion("otra-contrasena-equivocada");
    expect(
      await screen.findByText(MENSAJES.credencialesInvalidas),
    ).toBeTruthy();
    expect(f.de("POST /api/registro/confirmar-con-sesion")).toHaveLength(0);
  });

  it("cuenta existente: confirmar-con-sesion 400 (otro correo) → registro inválido", async () => {
    instalarFetchFalso(
      rutas(
        { status: 200, cuerpo: EXISTENTE },
        {
          "POST /api/auth/login": LOGIN_OK,
          "POST /api/registro/confirmar-con-sesion": {
            status: 400,
            cuerpo: { codigo: "registro_invalido" },
          },
        },
      ),
    );
    render(<ConfirmarRegistro />);
    await iniciarSesion();
    expect(
      await screen.findByText(MENSAJES_PLANES.registroInvalido),
    ).toBeTruthy();
    expect(
      screen.queryByText(MENSAJES_PLANES.estudioCreado("Estudio Gamma")),
    ).toBeNull();
  });

  it("tras crear el estudio, 'Cambiar a este estudio' hace POST /api/auth/estudio { tenantId } con CSRF y va a /", async () => {
    const f = instalarFetchFalso(
      rutas(
        { status: 200, cuerpo: EXISTENTE },
        {
          "POST /api/auth/login": LOGIN_OK,
          "POST /api/registro/confirmar-con-sesion": {
            status: 200,
            cuerpo: { estudio: { id: "e-nuevo", nombre: "Estudio Gamma" } },
          },
          "POST /api/auth/estudio": {
            status: 200,
            cuerpo: {
              estudioActivo: { id: "e-nuevo", nombre: "Estudio Gamma" },
            },
          },
        },
      ),
    );
    render(<ConfirmarRegistro />);
    const user = await iniciarSesion();
    await screen.findByText(MENSAJES_PLANES.estudioCreado("Estudio Gamma"));
    await user.click(
      screen.getByRole("button", { name: "Cambiar a este estudio" }),
    );
    await vi.waitFor(() => expect(destinos(router)).toEqual(["/"]));
    const [llamada] = f.de("POST /api/auth/estudio");
    expect(llamada?.body).toEqual({ tenantId: "e-nuevo" });
    expect(llamada?.headers["x-csrf-token"]).toBe("csrf-registro");
  });

  it("el token y la contraseña no aparecen en URLs, cabeceras, location, DOM ni consola (cuenta nueva con error)", async () => {
    const espias = espiarConsola();
    const f = instalarFetchFalso(
      rutas(
        { status: 200, cuerpo: NUEVA },
        {
          "POST /api/registro/confirmar": {
            status: 400,
            cuerpo: { codigo: "registro_invalido" },
          },
        },
      ),
    );
    const { container } = render(<ConfirmarRegistro />);
    await confirmar();
    await screen.findByText(MENSAJES_PLANES.registroInvalido);
    for (const l of f.llamadas) {
      expect(l.url).not.toContain(TOKEN);
      expect(JSON.stringify(l.headers)).not.toContain(TOKEN);
      expect(JSON.stringify(l.headers)).not.toContain(CONTRASENA);
    }
    expect(window.location.href).not.toContain(TOKEN);
    expect(container.innerHTML).not.toContain(TOKEN);
    expect(container.innerHTML).not.toContain(CONTRASENA);
    const visto = JSON.stringify(espias.flatMap((e) => e.mock.calls));
    expect(visto).not.toContain(TOKEN);
    expect(visto).not.toContain(CONTRASENA);
  });

  it("el token y la contraseña no aparecen en URLs, cabeceras, location, DOM ni consola (cuenta existente)", async () => {
    const espias = espiarConsola();
    const f = instalarFetchFalso(
      rutas(
        { status: 200, cuerpo: EXISTENTE },
        {
          "POST /api/auth/login": LOGIN_OK,
          "POST /api/registro/confirmar-con-sesion": {
            status: 200,
            cuerpo: { estudio: { id: "e-nuevo", nombre: "Estudio Gamma" } },
          },
        },
      ),
    );
    const { container } = render(<ConfirmarRegistro />);
    await iniciarSesion();
    await screen.findByText(MENSAJES_PLANES.estudioCreado("Estudio Gamma"));
    for (const l of f.llamadas) {
      expect(l.url).not.toContain(TOKEN);
      expect(JSON.stringify(l.headers)).not.toContain(TOKEN);
      expect(JSON.stringify(l.headers)).not.toContain(CONTRASENA);
    }
    expect(container.innerHTML).not.toContain(TOKEN);
    const visto = JSON.stringify(espias.flatMap((e) => e.mock.calls));
    expect(visto).not.toContain(TOKEN);
    expect(visto).not.toContain(CONTRASENA);
  });
});

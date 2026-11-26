import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../../lib/sesion";
import {
  MENSAJES,
  crearRouterFalso,
  destinos,
  instalarFetchFalso,
  type Manejador,
} from "../../../pruebas/soporte";
import { verificarSegundoFactorSchema } from "@contapp/shared";
import {
  CSRF_PENDIENTE,
  MENSAJES_SEG,
  errorSeg,
  respuestaSegundoFactor,
} from "../../../pruebas/seguridad";

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

// Contrato (plan 029, Contratos HTTP y Alcance «Login en dos pasos»; CA-2, CA-3, CA-6). La pantalla /login,
// tras `POST /api/auth/login` → 200 `{ segundoFactor: true, estudioActivo: null, csrf }` (sesión `pendiente`),
// NO navega y reemplaza el formulario por el paso de código:
//   - campo «Código de verificación» (type=text, inputMode numeric, autocomplete="one-time-code") y botón
//     «Verificar»; ya no muestra los campos «Correo» ni «Contraseña» (la contraseña no queda en pantalla);
//   - botón «Usar un código de recuperación» → cambia al campo «Código de recuperación» (+ «Verificar»);
//     un botón «Usar el código de mi aplicación» vuelve al anterior.
// `POST /api/auth/2fa/verificar` con `{ codigo }` o `{ codigoRecuperacion }`, con sesión y el `csrf` que trajo la
// respuesta del login (la `pendiente` no puede leer `GET /api/auth/sesion`, que da 401: no se llama; X-CSRF-Token =
// ese `csrf`; sin X-Estudio porque no hay estudio activo) y con `manejar401: false` (el 401 `codigo_invalido` NO es
// sesión caducada: se muestra, sin reintento ni /login).
//   200 → igual que el login: con estudioActivo → «/»; sin él → «/estudios».
//   401 → MENSAJES_SEG.codigoIncorrecto (mismo texto para TOTP y recuperación; el campo queda para reintentar).
//   429 → MENSAJES.demasiadosIntentos.
// Ni los códigos ni la contraseña aparecen en la URL, cabeceras, consola ni almacenamiento.

const CORREO = "ana@ejemplo.test";
const CONTRASENA = "canario-contrasena-de-prueba-1";
const CODIGO = "492817";
const RECUPERACION = "ABCD-EFGH-JK23";
const VERIFICAR = "POST /api/auth/2fa/verificar";
const SESION = "GET /api/auth/sesion";
const ESTUDIO = { id: "e-1", nombre: "Estudio Uno" };

function rutas(
  verificar: Manejador = {
    status: 200,
    cuerpo: { estudioActivo: ESTUDIO, requiereEstudio: false },
  },
): Record<string, Manejador> {
  return {
    "POST /api/auth/login": {
      status: 200,
      cuerpo: respuestaSegundoFactor(),
    },
    // La API responde 401 a la sesión pendiente en esta ruta; la pantalla no debe llamarla.
    [SESION]: { status: 401, cuerpo: { codigo: "no_autenticado" } },
    [VERIFICAR]: verificar,
  };
}

async function hastaElPasoDeCodigo() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Correo"), CORREO);
  await user.type(screen.getByLabelText("Contraseña"), CONTRASENA);
  await user.click(screen.getByRole("button", { name: "Ingresar" }));
  await screen.findByLabelText("Código de verificación");
  return user;
}

async function conRecuperacion() {
  const user = await hastaElPasoDeCodigo();
  await user.click(
    screen.getByRole("button", { name: "Usar un código de recuperación" }),
  );
  await screen.findByLabelText("Código de recuperación");
  return user;
}

describe("/login · paso de código (029)", () => {
  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    reiniciarSesion();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("con segundoFactor muestra el campo de código y NO navega ni sigue pidiendo correo y contraseña", async () => {
    instalarFetchFalso(rutas());
    render(<Login />);
    await hastaElPasoDeCodigo();
    const campo = screen.getByLabelText("Código de verificación");
    expect(campo.tagName).toBe("INPUT");
    expect(campo.getAttribute("autocomplete")).toBe("one-time-code");
    expect(campo.getAttribute("inputmode")).toBe("numeric");
    expect(screen.getByRole("button", { name: "Verificar" })).toBeTruthy();
    expect(screen.queryByLabelText("Correo")).toBeNull();
    expect(screen.queryByLabelText("Contraseña")).toBeNull();
    expect(destinos(router)).toEqual([]);
  });

  it("envía POST /2fa/verificar { codigo } con el csrf del login, sin leer GET /auth/sesion y sin X-Estudio", async () => {
    const f = instalarFetchFalso(rutas());
    render(<Login />);
    const user = await hastaElPasoDeCodigo();
    await user.type(screen.getByLabelText("Código de verificación"), CODIGO);
    await user.click(screen.getByRole("button", { name: "Verificar" }));
    await vi.waitFor(() => expect(f.de(VERIFICAR)).toHaveLength(1));
    const [llamada] = f.de(VERIFICAR);
    expect(llamada?.url).toBe("/api/auth/2fa/verificar");
    expect(llamada?.body).toEqual({ codigo: CODIGO });
    expect(verificarSegundoFactorSchema.safeParse(llamada?.body).success).toBe(
      true,
    );
    expect(llamada?.credentials).toBe("same-origin");
    expect(llamada?.headers["x-csrf-token"]).toBe(CSRF_PENDIENTE);
    expect(llamada?.headers["x-estudio"]).toBeUndefined();
    expect(f.de(SESION)).toHaveLength(0);
  });

  it("el csrf es el de la respuesta del login (no uno fijo) y también viaja con el código de recuperación", async () => {
    const otro = "b3Ryby1jc3JmLTEyMzQ1Njc4OTAtYWJjZGVmZ2hpamtsbQ";
    const f = instalarFetchFalso({
      ...rutas(),
      "POST /api/auth/login": { status: 200, cuerpo: respuestaSegundoFactor(otro) },
    });
    render(<Login />);
    const user = await conRecuperacion();
    await user.type(screen.getByLabelText("Código de recuperación"), RECUPERACION);
    await user.click(screen.getByRole("button", { name: "Verificar" }));
    await vi.waitFor(() => expect(f.de(VERIFICAR)).toHaveLength(1));
    expect(f.de(VERIFICAR)[0]?.headers["x-csrf-token"]).toBe(otro);
    expect(f.de(SESION)).toHaveLength(0);
  });

  it("un 401 de la verificación no vuelve a pedir GET /auth/sesion y el reintento reutiliza el mismo csrf", async () => {
    const f = instalarFetchFalso(
      rutas((_l, vez) =>
        vez === 1
          ? { status: 401, cuerpo: errorSeg("codigo_invalido") }
          : { status: 200, cuerpo: { estudioActivo: ESTUDIO, requiereEstudio: false } },
      ),
    );
    render(<Login />);
    const user = await hastaElPasoDeCodigo();
    const campo = screen.getByLabelText("Código de verificación");
    await user.type(campo, "000000");
    await user.click(screen.getByRole("button", { name: "Verificar" }));
    await screen.findByText(MENSAJES_SEG.codigoIncorrecto);
    await user.clear(campo);
    await user.type(campo, CODIGO);
    await user.click(screen.getByRole("button", { name: "Verificar" }));
    await vi.waitFor(() => expect(destinos(router)).toEqual(["/"]));
    expect(f.de(VERIFICAR).map((l) => l.headers["x-csrf-token"])).toEqual([CSRF_PENDIENTE, CSRF_PENDIENTE]);
    expect(f.de(SESION)).toHaveLength(0);
  });

  it("el csrf no queda en almacenamiento ni en la URL", async () => {
    instalarFetchFalso(rutas());
    render(<Login />);
    const user = await hastaElPasoDeCodigo();
    await user.type(screen.getByLabelText("Código de verificación"), CODIGO);
    await user.click(screen.getByRole("button", { name: "Verificar" }));
    await vi.waitFor(() => expect(destinos(router)).toEqual(["/"]));
    const almacenado = JSON.stringify([{ ...window.localStorage }, { ...window.sessionStorage }, document.cookie]);
    expect(almacenado).not.toContain(CSRF_PENDIENTE);
    expect(window.location.href).not.toContain(CSRF_PENDIENTE);
    expect(destinos(router).join("")).not.toContain(CSRF_PENDIENTE);
  });

  it("200 con un estudio activo → va a /", async () => {
    instalarFetchFalso(rutas());
    render(<Login />);
    const user = await hastaElPasoDeCodigo();
    await user.type(screen.getByLabelText("Código de verificación"), CODIGO);
    await user.click(screen.getByRole("button", { name: "Verificar" }));
    await vi.waitFor(() => expect(destinos(router)).toEqual(["/"]));
  });

  it("200 sin estudio activo (varios estudios) → va a /estudios", async () => {
    instalarFetchFalso(
      rutas({
        status: 200,
        cuerpo: { estudioActivo: null, requiereEstudio: true },
      }),
    );
    render(<Login />);
    const user = await hastaElPasoDeCodigo();
    await user.type(screen.getByLabelText("Código de verificación"), CODIGO);
    await user.click(screen.getByRole("button", { name: "Verificar" }));
    await vi.waitFor(() => expect(destinos(router)).toEqual(["/estudios"]));
  });

  it("«Usar un código de recuperación» cambia de campo y envía { codigoRecuperacion }", async () => {
    const f = instalarFetchFalso(rutas());
    render(<Login />);
    const user = await conRecuperacion();
    expect(screen.queryByLabelText("Código de verificación")).toBeNull();
    await user.type(
      screen.getByLabelText("Código de recuperación"),
      RECUPERACION,
    );
    await user.click(screen.getByRole("button", { name: "Verificar" }));
    await vi.waitFor(() => expect(f.de(VERIFICAR)).toHaveLength(1));
    expect(f.de(VERIFICAR)[0]?.body).toEqual({
      codigoRecuperacion: RECUPERACION,
    });
    expect(
      verificarSegundoFactorSchema.safeParse(f.de(VERIFICAR)[0]?.body).success,
    ).toBe(true);
    await vi.waitFor(() => expect(destinos(router)).toEqual(["/"]));
  });

  it("se puede volver del código de recuperación al de la aplicación", async () => {
    instalarFetchFalso(rutas());
    render(<Login />);
    const user = await conRecuperacion();
    await user.click(
      screen.getByRole("button", { name: "Usar el código de mi aplicación" }),
    );
    expect(await screen.findByLabelText("Código de verificación")).toBeTruthy();
    expect(screen.queryByLabelText("Código de recuperación")).toBeNull();
  });

  it("401 codigo_invalido → mensaje único, sin reintento, sin ir a /login y el campo sigue disponible", async () => {
    const f = instalarFetchFalso(
      rutas({ status: 401, cuerpo: errorSeg("codigo_invalido") }),
    );
    const asignar = vi.fn();
    vi.stubGlobal("location", {
      ...window.location,
      pathname: "/login",
      assign: asignar,
    });
    render(<Login />);
    const user = await hastaElPasoDeCodigo();
    await user.type(screen.getByLabelText("Código de verificación"), "000000");
    await user.click(screen.getByRole("button", { name: "Verificar" }));
    expect(await screen.findByText(MENSAJES_SEG.codigoIncorrecto)).toBeTruthy();
    expect(f.de(VERIFICAR)).toHaveLength(1);
    expect(asignar).not.toHaveBeenCalled();
    expect(destinos(router)).toEqual([]);
    expect(screen.getByLabelText("Código de verificación")).toBeTruthy();
  });

  it("401 con un código de recuperación → exactamente el mismo mensaje que con el TOTP", async () => {
    instalarFetchFalso(
      rutas({ status: 401, cuerpo: errorSeg("codigo_invalido") }),
    );
    render(<Login />);
    const user = await conRecuperacion();
    await user.type(
      screen.getByLabelText("Código de recuperación"),
      RECUPERACION,
    );
    await user.click(screen.getByRole("button", { name: "Verificar" }));
    expect(await screen.findByText(MENSAJES_SEG.codigoIncorrecto)).toBeTruthy();
  });

  it("429 demasiados_intentos → mensaje de demasiados intentos, distinto del de código incorrecto", async () => {
    instalarFetchFalso(
      rutas({ status: 429, cuerpo: { codigo: "demasiados_intentos" } }),
    );
    render(<Login />);
    const user = await hastaElPasoDeCodigo();
    await user.type(screen.getByLabelText("Código de verificación"), CODIGO);
    await user.click(screen.getByRole("button", { name: "Verificar" }));
    expect(await screen.findByText(MENSAJES.demasiadosIntentos)).toBeTruthy();
    expect(screen.queryByText(MENSAJES_SEG.codigoIncorrecto)).toBeNull();
    expect(MENSAJES.demasiadosIntentos).toBe(MENSAJES_SEG.demasiadosIntentos);
  });

  it("tras un error, el reintento vuelve a enviar y el 200 navega", async () => {
    const f = instalarFetchFalso(
      rutas((_l, vez) =>
        vez === 1
          ? { status: 401, cuerpo: errorSeg("codigo_invalido") }
          : {
              status: 200,
              cuerpo: { estudioActivo: ESTUDIO, requiereEstudio: false },
            },
      ),
    );
    render(<Login />);
    const user = await hastaElPasoDeCodigo();
    const campo = screen.getByLabelText("Código de verificación");
    await user.type(campo, "000000");
    await user.click(screen.getByRole("button", { name: "Verificar" }));
    await screen.findByText(MENSAJES_SEG.codigoIncorrecto);
    await user.clear(campo);
    await user.type(campo, CODIGO);
    await user.click(screen.getByRole("button", { name: "Verificar" }));
    await vi.waitFor(() => expect(destinos(router)).toEqual(["/"]));
    expect(f.de(VERIFICAR).map((l) => l.body)).toEqual([
      { codigo: "000000" },
      { codigo: CODIGO },
    ]);
  });

  it("contraseña y códigos no aparecen en la URL, cabeceras, consola ni almacenamiento", async () => {
    const espias = (["log", "info", "warn", "error", "debug"] as const).map(
      (m) => vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const f = instalarFetchFalso(
      rutas({ status: 401, cuerpo: errorSeg("codigo_invalido") }),
    );
    const { container } = render(<Login />);
    const user = await conRecuperacion();
    await user.type(
      screen.getByLabelText("Código de recuperación"),
      RECUPERACION,
    );
    await user.click(screen.getByRole("button", { name: "Verificar" }));
    await screen.findByText(MENSAJES_SEG.codigoIncorrecto);
    const [llamada] = f.de(VERIFICAR);
    const consola = JSON.stringify(espias.flatMap((e) => e.mock.calls));
    const almacenado = JSON.stringify([
      { ...window.localStorage },
      { ...window.sessionStorage },
    ]);
    for (const secreto of [CONTRASENA, RECUPERACION]) {
      expect(llamada?.url).not.toContain(secreto);
      expect(JSON.stringify(llamada?.headers)).not.toContain(secreto);
      expect(window.location.href).not.toContain(secreto);
      expect(consola).not.toContain(secreto);
      expect(almacenado).not.toContain(secreto);
    }
    expect(container.innerHTML).not.toContain(CONTRASENA);
  });
});

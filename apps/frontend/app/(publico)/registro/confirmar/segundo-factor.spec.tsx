import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verificarSegundoFactorSchema } from "@contapp/shared";
import { reiniciarSesion } from "../../../../lib/sesion";
import { MENSAJES_PLANES } from "../../../../pruebas/planes";
import {
  CSRF_PENDIENTE,
  MENSAJES_SEG,
  errorSeg,
  respuestaSegundoFactor,
  sesionSegura,
} from "../../../../pruebas/seguridad";
import {
  crearRouterFalso,
  destinos,
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
  usePathname: () => "/registro/confirmar",
  useSearchParams: () => new URLSearchParams(),
}));

import ConfirmarRegistro from "./page";

// Contrato (spec 029, T18a; P10 = a: el backend no cambia, CA-4 sigue con lista cerrada). /registro/confirmar con
// cuenta existente («Iniciar sesión y crear estudio») ya no pierde el token ante el segundo factor. El token solo
// vive en memoria (como 005 D15) y se descarta al terminar; nunca va a URL, cabeceras, consola ni almacenamiento.
//
// A. `POST /api/auth/login` → 200 `{ segundoFactor: true, estudioActivo: null, csrf }` (sesión `pendiente`):
//    la pantalla NO llama a `confirmar-con-sesion`, NO navega (ni `router` ni `window.location.assign`) y NO lee
//    `GET /auth/sesion` (da 401 con la `pendiente`). Reemplaza el formulario por el MISMO paso de código que
//    /login (componente compartido): campo «Código de verificación» (autocomplete one-time-code, inputMode
//    numeric) y botón «Verificar»; sin campo «Contraseña»; «Usar un código de recuperación» ⇄ «Usar el
//    código de mi aplicación» con el campo «Código de recuperación». Sigue mostrando el estudio y el correo.
// B. «Verificar» → `POST /api/auth/2fa/verificar` con `{ codigo }` o `{ codigoRecuperacion }`, `sinSesion` y el
//    `csrf` del login como `X-CSRF-Token` (sin `X-Estudio`, sin leer la sesión antes). El 401 `codigo_invalido`
//    muestra MENSAJES_SEG.codigoIncorrecto (mismo texto para ambos códigos) sin /login y sin perder el token;
//    el reintento reutiliza el mismo csrf; 429 → MENSAJES_SEG.demasiadosIntentos; 401 `sesion_invalida` →
//    MENSAJES_SEG.sesionCaducada y vuelve al formulario de contraseña CONSERVANDO el registro.
// C. Con 200: `reiniciarSesion()` y SIGUE el flujo de 006 sin que la persona repita nada: `POST
//    /api/registro/confirmar-con-sesion { token }` con el `X-CSRF-Token` de la sesión nueva (GET /auth/sesion)
//    → MENSAJES_PLANES.estudioCreado(estudio) y «Cambiar a este estudio». 400 → MENSAJES_PLANES.registroInvalido.
//    Terminado el flujo, el `csrf` del login y el código se descartan.
// D. Si tras el login (200 sin `segundoFactor`) `GET /auth/sesion` trae `factorExigido: true` y `factor` distinto
//    de `verificado` (Dueño sin TOTP, U1): NO se llama a `confirmar-con-sesion`, NO se redirige (ni `router` ni
//    `window.location.assign`: el token se perdería) y se muestra el aviso MENSAJES_SEG.exigidoAviso con el
//    enlace «Ir a Seguridad» a `/cuenta/seguridad`. El token sigue solo en memoria; tras enrolar, la persona
//    reabre el enlace del registro (P10 = a).

const TOKEN = "TokenCanarioDeRegistro_0123456789abcdefghijklmnopq";
const CORREO = "dueno.nuevo@ejemplo.test";
const CONTRASENA = "canario-contrasena-registro-123";
const CODIGO = "492817";
const RECUPERACION = "ABCD-EFGH-JK23";
const EXISTENTE = {
  estudio: { nombre: "Estudio Gamma" },
  correo: CORREO,
  cuentaExiste: true,
};
const VERIFICAR = "POST /api/auth/2fa/verificar";
const SESION = "GET /api/auth/sesion";
const CONFIRMAR = "POST /api/registro/confirmar-con-sesion";
const LOGIN = "POST /api/auth/login";
const ASIGNAR = vi.fn();

interface Opciones {
  login?: Manejador;
  verificar?: Manejador;
  confirmar?: Manejador;
  /** Estado de la sesión una vez que `verificar` respondió 200 (o tras un login sin segundo factor). */
  sesion?: Parameters<typeof sesionSegura>[0];
}

/** Rutas con la sesión `pendiente` (401 en GET /auth/sesion) hasta que la verificación responde 200. */
function rutas(o: Opciones = {}) {
  let verificada = false;
  const verificar: Manejador = o.verificar ?? {
    status: 200,
    cuerpo: { estudioActivo: null, requiereEstudio: false },
  };
  return {
    "POST /api/registro/consultar": { status: 200, cuerpo: EXISTENTE },
    [LOGIN]: o.login ?? { status: 200, cuerpo: respuestaSegundoFactor() },
    [VERIFICAR]: (l, vez) => {
      const r = typeof verificar === "function" ? verificar(l, vez) : verificar;
      if (r.status === 200) verificada = true;
      return r;
    },
    [SESION]: () =>
      verificada || o.login
        ? {
            status: 200,
            cuerpo: sesionSegura({
              factor: "verificado",
              totpActivo: true,
              estudio: null,
              csrf: "csrf-registro",
              ...o.sesion,
            }),
          }
        : { status: 401, cuerpo: { codigo: "no_autenticado" } },
    [CONFIRMAR]: o.confirmar ?? {
      status: 200,
      cuerpo: { estudio: { id: "e-nuevo", nombre: "Estudio Gamma" } },
    },
  } satisfies Record<string, Manejador>;
}

async function hastaElPasoDeCodigo() {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("Contraseña"), CONTRASENA);
  await user.click(
    screen.getByRole("button", { name: "Iniciar sesión y crear estudio" }),
  );
  await screen.findByLabelText("Código de verificación");
  return user;
}

async function verificarCon(
  user: ReturnType<typeof userEvent.setup>,
  c = CODIGO,
) {
  await user.type(screen.getByLabelText("Código de verificación"), c);
  await user.click(screen.getByRole("button", { name: "Verificar" }));
}

function espiarConsola() {
  return (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  );
}

describe("/registro/confirmar · segundo factor con cuenta existente (029, T18a)", () => {
  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    ASIGNAR.mockClear();
    window.history.replaceState(null, "", `/registro/confirmar#t=${TOKEN}`);
    vi.stubGlobal("location", {
      ...window.location,
      pathname: "/registro/confirmar",
      assign: ASIGNAR,
    });
    reiniciarSesion();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
  });

  it("A: con segundoFactor muestra el paso de código, sin Contraseña, sin confirmar, sin navegar y sin leer la sesión", async () => {
    const f = instalarFetchFalso(rutas());
    const { container } = render(<ConfirmarRegistro />);
    await hastaElPasoDeCodigo();
    const campo = screen.getByLabelText("Código de verificación");
    expect(campo.getAttribute("autocomplete")).toBe("one-time-code");
    expect(campo.getAttribute("inputmode")).toBe("numeric");
    expect(screen.getByRole("button", { name: "Verificar" })).toBeTruthy();
    expect(screen.queryByLabelText("Contraseña")).toBeNull();
    expect(container.textContent).toContain("Estudio Gamma");
    expect(container.textContent).toContain(CORREO);
    expect(f.de(CONFIRMAR)).toHaveLength(0);
    expect(f.de(SESION)).toHaveLength(0);
    expect(destinos(router)).toEqual([]);
    expect(ASIGNAR).not.toHaveBeenCalled();
  });

  it("B: verifica con { codigo }, el csrf del login, sin X-Estudio ni leer la sesión antes", async () => {
    const f = instalarFetchFalso(rutas());
    render(<ConfirmarRegistro />);
    const user = await hastaElPasoDeCodigo();
    await verificarCon(user);
    await vi.waitFor(() => expect(f.de(VERIFICAR)).toHaveLength(1));
    const [v] = f.de(VERIFICAR);
    expect(v?.url).toBe("/api/auth/2fa/verificar");
    expect(v?.body).toEqual({ codigo: CODIGO });
    expect(verificarSegundoFactorSchema.safeParse(v?.body).success).toBe(true);
    expect(v?.headers["x-csrf-token"]).toBe(CSRF_PENDIENTE);
    expect(v?.headers["x-estudio"]).toBeUndefined();
    expect(v?.credentials).toBe("same-origin");
    const orden = f.llamadas.map((l) => `${l.method} ${l.ruta}`);
    expect(orden.indexOf(VERIFICAR)).toBeLessThan(orden.indexOf(SESION));
  });

  it("C: tras verificar confirma el registro con el mismo token y el csrf de la sesión nueva", async () => {
    const f = instalarFetchFalso(rutas());
    render(<ConfirmarRegistro />);
    const user = await hastaElPasoDeCodigo();
    await verificarCon(user);
    expect(
      await screen.findByText(MENSAJES_PLANES.estudioCreado("Estudio Gamma")),
    ).toBeTruthy();
    const [confirmar] = f.de(CONFIRMAR);
    expect(confirmar?.body).toEqual({ token: TOKEN });
    expect(confirmar?.headers["x-csrf-token"]).toBe("csrf-registro");
    expect(confirmar?.headers["x-estudio"]).toBeUndefined();
    expect(f.de("POST /api/registro/confirmar")).toHaveLength(0);
    const orden = f.llamadas.map((l) => `${l.method} ${l.ruta}`);
    expect(orden.indexOf(LOGIN)).toBeLessThan(orden.indexOf(VERIFICAR));
    expect(orden.indexOf(VERIFICAR)).toBeLessThan(orden.indexOf(CONFIRMAR));
    expect(
      screen.getByRole("button", { name: "Cambiar a este estudio" }),
    ).toBeTruthy();
    expect(destinos(router)).toEqual([]);
    expect(ASIGNAR).not.toHaveBeenCalled();
  });

  it("C: con un código de recuperación envía { codigoRecuperacion } y también confirma", async () => {
    const f = instalarFetchFalso(rutas());
    render(<ConfirmarRegistro />);
    const user = await hastaElPasoDeCodigo();
    await user.click(
      screen.getByRole("button", { name: "Usar un código de recuperación" }),
    );
    await user.type(
      await screen.findByLabelText("Código de recuperación"),
      RECUPERACION,
    );
    await user.click(screen.getByRole("button", { name: "Verificar" }));
    expect(
      await screen.findByText(MENSAJES_PLANES.estudioCreado("Estudio Gamma")),
    ).toBeTruthy();
    expect(f.de(VERIFICAR)[0]?.body).toEqual({
      codigoRecuperacion: RECUPERACION,
    });
    expect(f.de(VERIFICAR)[0]?.headers["x-csrf-token"]).toBe(CSRF_PENDIENTE);
    expect(f.de(CONFIRMAR)[0]?.body).toEqual({ token: TOKEN });
  });

  it("B: se puede volver del código de recuperación al de la aplicación", async () => {
    instalarFetchFalso(rutas());
    render(<ConfirmarRegistro />);
    const user = await hastaElPasoDeCodigo();
    await user.click(
      screen.getByRole("button", { name: "Usar un código de recuperación" }),
    );
    await screen.findByLabelText("Código de recuperación");
    await user.click(
      screen.getByRole("button", { name: "Usar el código de mi aplicación" }),
    );
    expect(await screen.findByLabelText("Código de verificación")).toBeTruthy();
    expect(screen.queryByLabelText("Código de recuperación")).toBeNull();
  });

  it("B: 401 codigo_invalido → mensaje único, sin /login, y el reintento confirma con el mismo token y csrf", async () => {
    const f = instalarFetchFalso(
      rutas({
        verificar: (_l, vez) =>
          vez === 1
            ? { status: 401, cuerpo: errorSeg("codigo_invalido") }
            : {
                status: 200,
                cuerpo: { estudioActivo: null, requiereEstudio: false },
              },
      }),
    );
    render(<ConfirmarRegistro />);
    const user = await hastaElPasoDeCodigo();
    await verificarCon(user, "000000");
    expect(await screen.findByText(MENSAJES_SEG.codigoIncorrecto)).toBeTruthy();
    expect(f.de(CONFIRMAR)).toHaveLength(0);
    expect(f.de(SESION)).toHaveLength(0);
    expect(ASIGNAR).not.toHaveBeenCalled();
    expect(destinos(router)).toEqual([]);
    await user.clear(screen.getByLabelText("Código de verificación"));
    await verificarCon(user);
    expect(
      await screen.findByText(MENSAJES_PLANES.estudioCreado("Estudio Gamma")),
    ).toBeTruthy();
    expect(f.de(VERIFICAR).map((l) => l.headers["x-csrf-token"])).toEqual([
      CSRF_PENDIENTE,
      CSRF_PENDIENTE,
    ]);
    expect(f.de(CONFIRMAR)[0]?.body).toEqual({ token: TOKEN });
  });

  it("B: 429 → mensaje de demasiados intentos y sigue en el paso de código", async () => {
    instalarFetchFalso(
      rutas({
        verificar: { status: 429, cuerpo: { codigo: "demasiados_intentos" } },
      }),
    );
    render(<ConfirmarRegistro />);
    const user = await hastaElPasoDeCodigo();
    await verificarCon(user);
    expect(
      await screen.findByText(MENSAJES_SEG.demasiadosIntentos),
    ).toBeTruthy();
    expect(screen.queryByText(MENSAJES_SEG.codigoIncorrecto)).toBeNull();
    expect(screen.getByLabelText("Código de verificación")).toBeTruthy();
  });

  it("B: 401 sesion_invalida → «La sesión caducó», vuelve a pedir la contraseña y conserva el registro", async () => {
    let vez = 0;
    const base = rutas({
      verificar: { status: 401, cuerpo: { codigo: "sesion_invalida" } },
    });
    const f = instalarFetchFalso({
      ...base,
      [LOGIN]: () => {
        vez += 1;
        return { status: 200, cuerpo: respuestaSegundoFactor() };
      },
    });
    const { container } = render(<ConfirmarRegistro />);
    const user = await hastaElPasoDeCodigo();
    await verificarCon(user);
    expect(await screen.findByText(MENSAJES_SEG.sesionCaducada)).toBeTruthy();
    expect(await screen.findByLabelText("Contraseña")).toBeTruthy();
    expect(container.textContent).toContain("Estudio Gamma");
    expect(ASIGNAR).not.toHaveBeenCalled();
    // El registro se conserva: se puede iniciar sesión de nuevo sin reabrir el enlace.
    await user.type(screen.getByLabelText("Contraseña"), CONTRASENA);
    await user.click(
      screen.getByRole("button", { name: "Iniciar sesión y crear estudio" }),
    );
    await screen.findByLabelText("Código de verificación");
    expect(vez).toBe(2);
    expect(f.de("POST /api/registro/consultar")).toHaveLength(1);
  });

  it("C: confirmar-con-sesion 400 tras verificar → registro inválido", async () => {
    instalarFetchFalso(
      rutas({
        confirmar: { status: 400, cuerpo: { codigo: "registro_invalido" } },
      }),
    );
    render(<ConfirmarRegistro />);
    const user = await hastaElPasoDeCodigo();
    await verificarCon(user);
    expect(
      await screen.findByText(MENSAJES_PLANES.registroInvalido),
    ).toBeTruthy();
    expect(
      screen.queryByText(MENSAJES_PLANES.estudioCreado("Estudio Gamma")),
    ).toBeNull();
  });

  it("D: factor exigido y sin verificar → aviso con enlace a Seguridad, sin confirmar y sin redirigir", async () => {
    const f = instalarFetchFalso(
      rutas({
        login: {
          status: 200,
          cuerpo: { estudioActivo: null, requiereEstudio: false },
        },
        sesion: {
          factor: "sin_factor",
          totpActivo: false,
          factorExigido: true,
        },
      }),
    );
    render(<ConfirmarRegistro />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Contraseña"), CONTRASENA);
    await user.click(
      screen.getByRole("button", { name: "Iniciar sesión y crear estudio" }),
    );
    expect(await screen.findByText(MENSAJES_SEG.exigidoAviso)).toBeTruthy();
    const enlace = screen.getByRole("link", { name: "Ir a Seguridad" });
    expect(enlace.getAttribute("href")).toBe("/cuenta/seguridad");
    expect(f.de(CONFIRMAR)).toHaveLength(0);
    expect(f.de(VERIFICAR)).toHaveLength(0);
    expect(ASIGNAR).not.toHaveBeenCalled();
    expect(destinos(router)).toEqual([]);
    expect(screen.queryByText(MENSAJES_PLANES.registroInvalido)).toBeNull();
  });

  it("D: con el factor exigido pero ya verificado confirma con normalidad (sin aviso)", async () => {
    const f = instalarFetchFalso(
      rutas({
        login: {
          status: 200,
          cuerpo: { estudioActivo: null, requiereEstudio: false },
        },
        sesion: { factor: "verificado", totpActivo: true, factorExigido: true },
      }),
    );
    render(<ConfirmarRegistro />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Contraseña"), CONTRASENA);
    await user.click(
      screen.getByRole("button", { name: "Iniciar sesión y crear estudio" }),
    );
    expect(
      await screen.findByText(MENSAJES_PLANES.estudioCreado("Estudio Gamma")),
    ).toBeTruthy();
    expect(screen.queryByText(MENSAJES_SEG.exigidoAviso)).toBeNull();
    expect(f.de(CONFIRMAR)).toHaveLength(1);
  });

  it("el token, la contraseña, el csrf y los códigos no aparecen en URLs, cabeceras de otros datos, consola, DOM ni almacenamiento", async () => {
    const espias = espiarConsola();
    const f = instalarFetchFalso(
      rutas({
        verificar: { status: 401, cuerpo: errorSeg("codigo_invalido") },
      }),
    );
    const { container } = render(<ConfirmarRegistro />);
    const user = await hastaElPasoDeCodigo();
    await user.click(
      screen.getByRole("button", { name: "Usar un código de recuperación" }),
    );
    await user.type(
      await screen.findByLabelText("Código de recuperación"),
      RECUPERACION,
    );
    await user.click(screen.getByRole("button", { name: "Verificar" }));
    await screen.findByText(MENSAJES_SEG.codigoIncorrecto);
    const consola = JSON.stringify(espias.flatMap((e) => e.mock.calls));
    const almacenado = JSON.stringify([
      { ...window.localStorage },
      { ...window.sessionStorage },
      document.cookie,
    ]);
    for (const secreto of [TOKEN, CONTRASENA, CSRF_PENDIENTE, RECUPERACION]) {
      for (const l of f.llamadas) expect(l.url).not.toContain(secreto);
      expect(consola).not.toContain(secreto);
      expect(almacenado).not.toContain(secreto);
      expect(container.innerHTML).not.toContain(secreto);
    }
    for (const l of f.llamadas) {
      expect(JSON.stringify(l.headers)).not.toContain(TOKEN);
      expect(JSON.stringify(l.headers)).not.toContain(CONTRASENA);
    }
  });
});

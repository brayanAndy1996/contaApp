// 030 · T16: cobertura de la pantalla /invitacion en los caminos de error y de carga que las demás
// pruebas no recorren (consulta fallida, red caída, desmontaje en vuelo, 429/5xx y 401 en cada paso).
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../../lib/sesion";
import { MENSAJES_ACCESO } from "../../../pruebas/acceso";
import {
  MENSAJES,
  crearRouterFalso,
  instalarFetchFalso,
  sesionDe,
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
  usePathname: () => "/invitacion",
  useSearchParams: () => new URLSearchParams(),
}));

import Invitacion from "./page";

const TOKEN = "TokenCanarioDeInvitacion_0123456789abcdefghijklmno";
const CORREO = "nuevo@ejemplo.test";
const CONTRASENA = "canario-contrasena-invitada-123";
const ERROR_GENERAL = "Ocurrió un error. Inténtalo de nuevo.";
const NUEVA = {
  estudio: { nombre: "Estudio Alfa" },
  rol: "contador",
  correo: CORREO,
  cuentaExiste: false,
};
const EXISTENTE = { ...NUEVA, cuentaExiste: true };
const RED_CAIDA: Manejador = () => {
  throw new Error("red caída");
};

function rutas(
  consulta: Manejador,
  extra: Record<string, Manejador> = {},
): Record<string, Manejador> {
  return {
    "POST /api/invitaciones/consultar": consulta,
    "GET /api/auth/sesion": {
      status: 200,
      cuerpo: sesionDe(null, "csrf-invitacion"),
    },
    ...extra,
  };
}

async function crearCuenta() {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("Nombre"), "Nora Nueva");
  await user.type(screen.getByLabelText("Contraseña"), CONTRASENA);
  await user.click(
    screen.getByRole("button", { name: "Crear cuenta y aceptar" }),
  );
}

async function iniciarSesion() {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("Contraseña"), CONTRASENA);
  await user.click(
    screen.getByRole("button", { name: "Iniciar sesión y aceptar" }),
  );
  return user;
}

const LOGIN_OK: Manejador = {
  status: 200,
  cuerpo: { estudioActivo: null, requiereEstudio: false },
};

describe("/invitacion · errores y carga (030, T16)", () => {
  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    window.history.replaceState(null, "", `/invitacion#t=${TOKEN}`);
    reiniciarSesion();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
  });

  it("mientras consulta muestra «Verificando la invitación…» y sin formulario", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    render(<Invitacion />);
    expect(await screen.findByText("Verificando la invitación…")).toBeTruthy();
    expect(screen.queryByLabelText("Contraseña")).toBeNull();
  });

  it("consultar 500 → error general (no «invitación inválida») y sin formulario", async () => {
    instalarFetchFalso(rutas({ status: 500, cuerpo: {} }));
    render(<Invitacion />);
    expect(await screen.findByText(ERROR_GENERAL)).toBeTruthy();
    expect(screen.queryByText(MENSAJES_ACCESO.invitacionInvalida)).toBeNull();
    expect(screen.queryByLabelText("Contraseña")).toBeNull();
  });

  it("consultar con la red caída → error general", async () => {
    instalarFetchFalso(rutas(RED_CAIDA));
    render(<Invitacion />);
    expect(await screen.findByText(ERROR_GENERAL)).toBeTruthy();
    expect(screen.queryByLabelText("Contraseña")).toBeNull();
  });

  it("desmontar antes de que responda la consulta no actualiza nada ni falla", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let responder!: (r: Response) => void;
    const fetchFalso = vi.fn(
      () => new Promise<Response>((resolver) => (responder = resolver)),
    );
    vi.stubGlobal("fetch", fetchFalso);
    const { unmount, container } = render(<Invitacion />);
    await vi.waitFor(() => expect(fetchFalso).toHaveBeenCalledTimes(1));
    unmount();
    responder(new Response(JSON.stringify(NUEVA), { status: 200 }));
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe("");
    expect(error).not.toHaveBeenCalled();
  });

  it("desmontar antes de que falle la consulta (red caída) tampoco falla", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let fallar!: (e: Error) => void;
    const fetchFalso = vi.fn(
      () => new Promise<Response>((_, rechazar) => (fallar = rechazar)),
    );
    vi.stubGlobal("fetch", fetchFalso);
    const { unmount, container } = render(<Invitacion />);
    await vi.waitFor(() => expect(fetchFalso).toHaveBeenCalledTimes(1));
    unmount();
    fallar(new Error("red caída"));
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe("");
    expect(error).not.toHaveBeenCalled();
  });

  it("cuenta nueva: aceptar 500 → error general, vuelve a habilitar el botón y conserva el formulario", async () => {
    instalarFetchFalso(
      rutas(
        { status: 200, cuerpo: NUEVA },
        { "POST /api/invitaciones/aceptar": { status: 500, cuerpo: {} } },
      ),
    );
    render(<Invitacion />);
    await crearCuenta();
    expect(await screen.findByText(ERROR_GENERAL)).toBeTruthy();
    const boton = screen.getByRole("button", { name: "Crear cuenta y aceptar" });
    expect((boton as HTMLButtonElement).disabled).toBe(false);
  });

  it("cuenta nueva: aceptar con la red caída → error general", async () => {
    instalarFetchFalso(
      rutas(
        { status: 200, cuerpo: NUEVA },
        { "POST /api/invitaciones/aceptar": RED_CAIDA },
      ),
    );
    render(<Invitacion />);
    await crearCuenta();
    expect(await screen.findByText(ERROR_GENERAL)).toBeTruthy();
    expect(screen.queryByText(MENSAJES_ACCESO.unidoA("Estudio Alfa"))).toBeNull();
  });

  it("cuenta existente: login 429 → demasiados intentos y no intenta aceptar", async () => {
    const f = instalarFetchFalso(
      rutas(
        { status: 200, cuerpo: EXISTENTE },
        { "POST /api/auth/login": { status: 429, cuerpo: {} } },
      ),
    );
    render(<Invitacion />);
    await iniciarSesion();
    expect(await screen.findByText(MENSAJES.demasiadosIntentos)).toBeTruthy();
    expect(f.de("POST /api/invitaciones/aceptar-con-sesion")).toHaveLength(0);
  });

  it("cuenta existente: login 500 → error general y no intenta aceptar", async () => {
    const f = instalarFetchFalso(
      rutas(
        { status: 200, cuerpo: EXISTENTE },
        { "POST /api/auth/login": { status: 500, cuerpo: {} } },
      ),
    );
    render(<Invitacion />);
    await iniciarSesion();
    expect(await screen.findByText(ERROR_GENERAL)).toBeTruthy();
    expect(f.de("POST /api/invitaciones/aceptar-con-sesion")).toHaveLength(0);
  });

  it("cuenta existente: login con la red caída → error general", async () => {
    instalarFetchFalso(
      rutas(
        { status: 200, cuerpo: EXISTENTE },
        { "POST /api/auth/login": RED_CAIDA },
      ),
    );
    render(<Invitacion />);
    await iniciarSesion();
    expect(await screen.findByText(ERROR_GENERAL)).toBeTruthy();
  });

  it("cuenta existente: aceptar-con-sesion 500 → error general y sigue en el formulario", async () => {
    instalarFetchFalso(
      rutas(
        { status: 200, cuerpo: EXISTENTE },
        {
          "POST /api/auth/login": LOGIN_OK,
          "POST /api/invitaciones/aceptar-con-sesion": {
            status: 500,
            cuerpo: {},
          },
        },
      ),
    );
    render(<Invitacion />);
    await iniciarSesion();
    expect(await screen.findByText(ERROR_GENERAL)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Iniciar sesión y aceptar" }),
    ).toBeTruthy();
    expect(screen.queryByText(MENSAJES_ACCESO.unidoA("Estudio Alfa"))).toBeNull();
  });

  it("cuenta existente: aceptar-con-sesion 401 → no muestra error general ni «unido»", async () => {
    const f = instalarFetchFalso(
      rutas(
        { status: 200, cuerpo: EXISTENTE },
        {
          "POST /api/auth/login": LOGIN_OK,
          "POST /api/invitaciones/aceptar-con-sesion": {
            status: 401,
            cuerpo: {},
          },
        },
      ),
    );
    render(<Invitacion />);
    await iniciarSesion();
    await vi.waitFor(() =>
      expect(
        f.de("POST /api/invitaciones/aceptar-con-sesion").length,
      ).toBeGreaterThan(0),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(ERROR_GENERAL)).toBeNull();
    expect(screen.queryByText(MENSAJES_ACCESO.unidoA("Estudio Alfa"))).toBeNull();
  });

  describe("tras unirse, «Cambiar a este estudio»", () => {
    async function unirse(estudio: Manejador) {
      const f = instalarFetchFalso(
        rutas(
          { status: 200, cuerpo: EXISTENTE },
          {
            "POST /api/auth/login": LOGIN_OK,
            "POST /api/invitaciones/aceptar-con-sesion": {
              status: 200,
              cuerpo: { estudio: { id: "e-nuevo", nombre: "Estudio Alfa" } },
            },
            "POST /api/auth/estudio": estudio,
          },
        ),
      );
      render(<Invitacion />);
      const user = await iniciarSesion();
      await screen.findByText(MENSAJES_ACCESO.unidoA("Estudio Alfa"));
      await user.click(
        screen.getByRole("button", { name: "Cambiar a este estudio" }),
      );
      return f;
    }

    it("500 → error general y no navega", async () => {
      await unirse({ status: 500, cuerpo: {} });
      expect(await screen.findByText(ERROR_GENERAL)).toBeTruthy();
      expect(router.push).not.toHaveBeenCalled();
    });

    it("con la red caída → error general y no navega", async () => {
      await unirse(RED_CAIDA);
      expect(await screen.findByText(ERROR_GENERAL)).toBeTruthy();
      expect(router.push).not.toHaveBeenCalled();
    });

    it("401 → no muestra error general ni navega", async () => {
      const f = await unirse({ status: 401, cuerpo: {} });
      await vi.waitFor(() =>
        expect(f.de("POST /api/auth/estudio").length).toBeGreaterThan(0),
      );
      await new Promise((r) => setTimeout(r, 50));
      expect(screen.queryByText(ERROR_GENERAL)).toBeNull();
      expect(router.push).not.toHaveBeenCalled();
    });
  });
});

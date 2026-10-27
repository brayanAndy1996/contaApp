import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../../lib/sesion";
import { MENSAJES_ACCESO } from "../../../pruebas/acceso";
import {
  MENSAJES,
  crearRouterFalso,
  destinos,
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

// Contrato (plan 005, Frontend; Decisiones: Aceptación; CA-3, CA-14, CA-15, D7, D15). Pantalla
// /invitacion: el token viaja en el fragmento `#t=<token>`. Al montar lo lee, lo guarda solo en
// memoria y borra el fragmento con history.replaceState; nunca aparece en la URL de una petición,
// cabeceras, location, DOM ni consola (solo en el cuerpo JSON de los POST).
// - Sin fragmento → MENSAJES_ACCESO.invitacionInvalida y ninguna petición.
// - POST /api/invitaciones/consultar { token } sin sesión → { estudio:{nombre}, rol, correo,
//   cuentaExiste }. 400 invitacion_invalida → invitacionInvalida y sin formulario.
// - cuentaExiste = false: muestra el estudio, el rol (etiqueta) y el correo (solo texto), campos
//   "Nombre" y "Contraseña" y botón "Crear cuenta y aceptar". Valida 12–128 caracteres antes de
//   enviar (si no: MENSAJES.contrasenaLongitud, sin petición). POST /api/invitaciones/aceptar
//   { token, nombre, contrasena } sin sesión: 204 → MENSAJES_ACCESO.cuentaCreada y enlace
//   "Ir a iniciar sesión" a /login; 400 contrasena_invalida (motivo longitud | comun) → mensaje de
//   004; 400 invitacion_invalida → invitacionInvalida; 409 requiere_sesion → pasa al modo de abajo.
// - cuentaExiste = true: muestra el correo (solo texto, no editable), el campo "Contraseña" y el
//   botón "Iniciar sesión y aceptar". POST /api/auth/login { correo (el de la invitación),
//   contrasena } sin sesión; 401 → MENSAJES.credencialesInvalidas. Con 200: reinicia la sesión y
//   POST /api/invitaciones/aceptar-con-sesion { token } con X-CSRF-Token de la sesión nueva (no llama
//   a /invitaciones/aceptar). 200 { estudio:{id,nombre} } → MENSAJES_ACCESO.unidoA(nombre) y botón
//   "Cambiar a este estudio" (POST /api/auth/estudio { tenantId: id } con CSRF → reinicia la sesión y
//   va a "/"). 400 invitacion_invalida (otro correo, ya miembro) → invitacionInvalida.

const TOKEN = "TokenCanarioDeInvitacion_0123456789abcdefghijklmno";
const CORREO = "nuevo@ejemplo.test";
const CONTRASENA = "canario-contrasena-invitada-123";
const NUEVA = {
  estudio: { nombre: "Estudio Alfa" },
  rol: "contador",
  correo: CORREO,
  cuentaExiste: false,
};
const EXISTENTE = { ...NUEVA, cuentaExiste: true };

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

async function crearCuenta(nombre = "Nora Nueva", contrasena = CONTRASENA) {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("Nombre"), nombre);
  await user.type(screen.getByLabelText("Contraseña"), contrasena);
  await user.click(
    screen.getByRole("button", { name: "Crear cuenta y aceptar" }),
  );
  return user;
}

async function iniciarSesion(contrasena = CONTRASENA) {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("Contraseña"), contrasena);
  await user.click(
    screen.getByRole("button", { name: "Iniciar sesión y aceptar" }),
  );
  return user;
}

function espiarConsola() {
  return (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  );
}

describe("/invitacion", () => {
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

  it("al montar borra el fragmento de la URL con history.replaceState", async () => {
    instalarFetchFalso(rutas({ status: 200, cuerpo: NUEVA }));
    const espia = vi.spyOn(window.history, "replaceState");
    render(<Invitacion />);
    await vi.waitFor(() => expect(espia).toHaveBeenCalled());
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(TOKEN);
    expect(window.location.pathname).toBe("/invitacion");
  });

  it("consulta con POST /api/invitaciones/consultar { token }, sin sesión, y muestra estudio, rol y correo", async () => {
    const f = instalarFetchFalso(rutas({ status: 200, cuerpo: NUEVA }));
    const { container } = render(<Invitacion />);
    await screen.findByLabelText("Nombre");
    expect(container.textContent).toContain("Estudio Alfa");
    expect(container.textContent).toContain("Contador");
    expect(container.textContent).toContain(CORREO);
    const [llamada] = f.de("POST /api/invitaciones/consultar");
    expect(llamada?.body).toEqual({ token: TOKEN });
    expect(llamada?.url).toBe("/api/invitaciones/consultar");
    expect(llamada?.credentials).toBe("same-origin");
    expect(llamada?.headers["x-csrf-token"]).toBeUndefined();
    expect(llamada?.headers["x-estudio"]).toBeUndefined();
    expect(f.de("GET /api/auth/sesion")).toHaveLength(0);
  });

  it("el correo de la invitación no es un campo editable", async () => {
    instalarFetchFalso(rutas({ status: 200, cuerpo: NUEVA }));
    render(<Invitacion />);
    await screen.findByLabelText("Nombre");
    expect(screen.queryByLabelText("Correo")).toBeNull();
    expect(screen.queryByDisplayValue(CORREO)).toBeNull();
  });

  it("sin fragmento #t= muestra invitación inválida y no hace ninguna petición", async () => {
    window.history.replaceState(null, "", "/invitacion");
    const f = instalarFetchFalso({});
    render(<Invitacion />);
    expect(
      await screen.findByText(MENSAJES_ACCESO.invitacionInvalida),
    ).toBeTruthy();
    expect(f.llamadas).toHaveLength(0);
  });

  it("consultar 400 invitacion_invalida → mensaje genérico y sin formulario", async () => {
    instalarFetchFalso(
      rutas({ status: 400, cuerpo: { codigo: "invitacion_invalida" } }),
    );
    render(<Invitacion />);
    expect(
      await screen.findByText(MENSAJES_ACCESO.invitacionInvalida),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Contraseña")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("cuenta nueva: POST /api/invitaciones/aceptar { token, nombre, contrasena } sin sesión; 204 → éxito y enlace a /login", async () => {
    const f = instalarFetchFalso(
      rutas(
        { status: 200, cuerpo: NUEVA },
        { "POST /api/invitaciones/aceptar": { status: 204 } },
      ),
    );
    render(<Invitacion />);
    await crearCuenta();
    expect(await screen.findByText(MENSAJES_ACCESO.cuentaCreada)).toBeTruthy();
    const enlace = screen.getByRole("link", { name: "Ir a iniciar sesión" });
    expect(enlace.getAttribute("href")).toBe("/login");
    const [llamada] = f.de("POST /api/invitaciones/aceptar");
    expect(llamada?.body).toEqual({
      token: TOKEN,
      nombre: "Nora Nueva",
      contrasena: CONTRASENA,
    });
    expect(llamada?.credentials).toBe("same-origin");
    expect(llamada?.headers["x-csrf-token"]).toBeUndefined();
    expect(f.de("POST /api/auth/login")).toHaveLength(0);
  });

  it("la contraseña es de tipo password", async () => {
    instalarFetchFalso(rutas({ status: 200, cuerpo: NUEVA }));
    render(<Invitacion />);
    expect(
      (await screen.findByLabelText("Contraseña")).getAttribute("type"),
    ).toBe("password");
  });

  it("contraseña de 11 caracteres → mensaje de longitud y no envía la aceptación", async () => {
    const f = instalarFetchFalso(rutas({ status: 200, cuerpo: NUEVA }));
    render(<Invitacion />);
    await crearCuenta("Nora Nueva", "A".repeat(11));
    expect(await screen.findByText(MENSAJES.contrasenaLongitud)).toBeTruthy();
    expect(f.de("POST /api/invitaciones/aceptar")).toHaveLength(0);
  });

  it("contraseña de 129 caracteres → mensaje de longitud y no envía la aceptación", async () => {
    const f = instalarFetchFalso(rutas({ status: 200, cuerpo: NUEVA }));
    render(<Invitacion />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Nombre"), "Nora Nueva");
    await user.click(screen.getByLabelText("Contraseña"));
    await user.paste("A".repeat(129));
    await user.click(
      screen.getByRole("button", { name: "Crear cuenta y aceptar" }),
    );
    expect(await screen.findByText(MENSAJES.contrasenaLongitud)).toBeTruthy();
    expect(f.de("POST /api/invitaciones/aceptar")).toHaveLength(0);
  });

  it("aceptar 400 contrasena_invalida comun → mensaje de contraseña común, y el reintento reutiliza el mismo token", async () => {
    const f = instalarFetchFalso(
      rutas(
        { status: 200, cuerpo: NUEVA },
        {
          "POST /api/invitaciones/aceptar": (_l, vez) =>
            vez === 1
              ? {
                  status: 400,
                  cuerpo: { codigo: "contrasena_invalida", motivo: "comun" },
                }
              : { status: 204 },
        },
      ),
    );
    render(<Invitacion />);
    const user = await crearCuenta("Nora Nueva", "contrasena-comun-123");
    expect(await screen.findByText(MENSAJES.contrasenaComun)).toBeTruthy();
    const campo = screen.getByLabelText("Contraseña");
    await user.clear(campo);
    await user.type(campo, CONTRASENA);
    await user.click(
      screen.getByRole("button", { name: "Crear cuenta y aceptar" }),
    );
    await screen.findByText(MENSAJES_ACCESO.cuentaCreada);
    const posts = f.de("POST /api/invitaciones/aceptar");
    expect(posts).toHaveLength(2);
    expect(posts[1]?.body).toEqual({
      token: TOKEN,
      nombre: "Nora Nueva",
      contrasena: CONTRASENA,
    });
  });

  it("aceptar 400 contrasena_invalida longitud (servidor) → mensaje de longitud", async () => {
    instalarFetchFalso(
      rutas(
        { status: 200, cuerpo: NUEVA },
        {
          "POST /api/invitaciones/aceptar": {
            status: 400,
            cuerpo: { codigo: "contrasena_invalida", motivo: "longitud" },
          },
        },
      ),
    );
    render(<Invitacion />);
    await crearCuenta();
    expect(await screen.findByText(MENSAJES.contrasenaLongitud)).toBeTruthy();
  });

  it("aceptar 400 invitacion_invalida → mensaje genérico", async () => {
    instalarFetchFalso(
      rutas(
        { status: 200, cuerpo: NUEVA },
        {
          "POST /api/invitaciones/aceptar": {
            status: 400,
            cuerpo: { codigo: "invitacion_invalida" },
          },
        },
      ),
    );
    render(<Invitacion />);
    await crearCuenta();
    expect(
      await screen.findByText(MENSAJES_ACCESO.invitacionInvalida),
    ).toBeTruthy();
  });

  it("aceptar 409 requiere_sesion (la cuenta apareció) → pasa a iniciar sesión sin perder el token", async () => {
    const f = instalarFetchFalso(
      rutas(
        { status: 200, cuerpo: NUEVA },
        {
          "POST /api/invitaciones/aceptar": {
            status: 409,
            cuerpo: { codigo: "requiere_sesion" },
          },
          "POST /api/auth/login": {
            status: 200,
            cuerpo: { estudioActivo: null, requiereEstudio: false },
          },
          "POST /api/invitaciones/aceptar-con-sesion": {
            status: 200,
            cuerpo: { estudio: { id: "e-nuevo", nombre: "Estudio Alfa" } },
          },
        },
      ),
    );
    render(<Invitacion />);
    await crearCuenta();
    expect(
      await screen.findByRole("button", { name: "Iniciar sesión y aceptar" }),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Nombre")).toBeNull();
    await iniciarSesion();
    await screen.findByText(MENSAJES_ACCESO.unidoA("Estudio Alfa"));
    const [llamada] = f.de("POST /api/invitaciones/aceptar-con-sesion");
    expect(llamada?.body).toEqual({ token: TOKEN });
  });

  it("cuenta existente: muestra el correo fijo, sin campo Nombre, y pide iniciar sesión", async () => {
    instalarFetchFalso(rutas({ status: 200, cuerpo: EXISTENTE }));
    const { container } = render(<Invitacion />);
    expect(
      await screen.findByRole("button", { name: "Iniciar sesión y aceptar" }),
    ).toBeTruthy();
    expect(container.textContent).toContain(CORREO);
    expect(screen.queryByLabelText("Nombre")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Crear cuenta y aceptar" }),
    ).toBeNull();
    expect(screen.queryByLabelText("Correo")).toBeNull();
    expect(screen.getByLabelText("Contraseña").getAttribute("type")).toBe(
      "password",
    );
  });

  it("cuenta existente: login con el correo de la invitación y luego aceptar-con-sesion con el CSRF de la sesión nueva", async () => {
    const f = instalarFetchFalso(
      rutas(
        { status: 200, cuerpo: EXISTENTE },
        {
          "POST /api/auth/login": {
            status: 200,
            cuerpo: { estudioActivo: null, requiereEstudio: false },
          },
          "POST /api/invitaciones/aceptar-con-sesion": {
            status: 200,
            cuerpo: { estudio: { id: "e-nuevo", nombre: "Estudio Alfa" } },
          },
        },
      ),
    );
    render(<Invitacion />);
    await iniciarSesion();
    expect(
      await screen.findByText(MENSAJES_ACCESO.unidoA("Estudio Alfa")),
    ).toBeTruthy();
    const [login] = f.de("POST /api/auth/login");
    expect(login?.body).toEqual({ correo: CORREO, contrasena: CONTRASENA });
    expect(login?.headers["x-csrf-token"]).toBeUndefined();
    const [aceptar] = f.de("POST /api/invitaciones/aceptar-con-sesion");
    expect(aceptar?.body).toEqual({ token: TOKEN });
    expect(aceptar?.headers["x-csrf-token"]).toBe("csrf-invitacion");
    expect(aceptar?.headers["x-estudio"]).toBeUndefined();
    expect(f.de("POST /api/invitaciones/aceptar")).toHaveLength(0);
    const orden = f.llamadas.map((l) => `${l.method} ${l.ruta}`);
    expect(orden.indexOf("POST /api/auth/login")).toBeLessThan(
      orden.indexOf("POST /api/invitaciones/aceptar-con-sesion"),
    );
  });

  it("cuenta existente: login 401 → mensaje genérico y no intenta aceptar", async () => {
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
    render(<Invitacion />);
    await iniciarSesion("otra-contrasena-equivocada");
    expect(
      await screen.findByText(MENSAJES.credencialesInvalidas),
    ).toBeTruthy();
    expect(f.de("POST /api/invitaciones/aceptar-con-sesion")).toHaveLength(0);
  });

  it("cuenta existente: aceptar-con-sesion 400 (otro correo o ya miembro) → invitación inválida", async () => {
    instalarFetchFalso(
      rutas(
        { status: 200, cuerpo: EXISTENTE },
        {
          "POST /api/auth/login": {
            status: 200,
            cuerpo: { estudioActivo: null, requiereEstudio: false },
          },
          "POST /api/invitaciones/aceptar-con-sesion": {
            status: 400,
            cuerpo: { codigo: "invitacion_invalida" },
          },
        },
      ),
    );
    render(<Invitacion />);
    await iniciarSesion();
    expect(
      await screen.findByText(MENSAJES_ACCESO.invitacionInvalida),
    ).toBeTruthy();
    expect(
      screen.queryByText(MENSAJES_ACCESO.unidoA("Estudio Alfa")),
    ).toBeNull();
  });

  it("tras unirse, 'Cambiar a este estudio' hace POST /api/auth/estudio { tenantId } con CSRF y va a /", async () => {
    const f = instalarFetchFalso(
      rutas(
        { status: 200, cuerpo: EXISTENTE },
        {
          "POST /api/auth/login": {
            status: 200,
            cuerpo: { estudioActivo: null, requiereEstudio: false },
          },
          "POST /api/invitaciones/aceptar-con-sesion": {
            status: 200,
            cuerpo: { estudio: { id: "e-nuevo", nombre: "Estudio Alfa" } },
          },
          "POST /api/auth/estudio": {
            status: 200,
            cuerpo: {
              estudioActivo: { id: "e-nuevo", nombre: "Estudio Alfa" },
            },
          },
        },
      ),
    );
    render(<Invitacion />);
    const user = await iniciarSesion();
    await screen.findByText(MENSAJES_ACCESO.unidoA("Estudio Alfa"));
    await user.click(
      screen.getByRole("button", { name: "Cambiar a este estudio" }),
    );
    await vi.waitFor(() => expect(destinos(router)).toEqual(["/"]));
    const [llamada] = f.de("POST /api/auth/estudio");
    expect(llamada?.body).toEqual({ tenantId: "e-nuevo" });
    expect(llamada?.headers["x-csrf-token"]).toBe("csrf-invitacion");
  });

  it("el token no aparece en URLs, cabeceras, location, DOM ni consola (cuenta nueva con error)", async () => {
    const espias = espiarConsola();
    const f = instalarFetchFalso(
      rutas(
        { status: 200, cuerpo: NUEVA },
        {
          "POST /api/invitaciones/aceptar": {
            status: 400,
            cuerpo: { codigo: "invitacion_invalida" },
          },
        },
      ),
    );
    const { container } = render(<Invitacion />);
    await crearCuenta();
    await screen.findByText(MENSAJES_ACCESO.invitacionInvalida);
    for (const l of f.llamadas) {
      expect(l.url).not.toContain(TOKEN);
      expect(JSON.stringify(l.headers)).not.toContain(TOKEN);
    }
    expect(window.location.href).not.toContain(TOKEN);
    expect(container.innerHTML).not.toContain(TOKEN);
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
          "POST /api/auth/login": {
            status: 200,
            cuerpo: { estudioActivo: null, requiereEstudio: false },
          },
          "POST /api/invitaciones/aceptar-con-sesion": {
            status: 200,
            cuerpo: { estudio: { id: "e-nuevo", nombre: "Estudio Alfa" } },
          },
        },
      ),
    );
    const { container } = render(<Invitacion />);
    await iniciarSesion();
    await screen.findByText(MENSAJES_ACCESO.unidoA("Estudio Alfa"));
    for (const l of f.llamadas) {
      expect(l.url).not.toContain(TOKEN);
      expect(JSON.stringify(l.headers)).not.toContain(TOKEN);
      expect(JSON.stringify(l.headers)).not.toContain(CONTRASENA);
    }
    expect(window.location.href).not.toContain(TOKEN);
    expect(container.innerHTML).not.toContain(TOKEN);
    const visto = JSON.stringify(espias.flatMap((e) => e.mock.calls));
    expect(visto).not.toContain(TOKEN);
    expect(visto).not.toContain(CONTRASENA);
  });
});

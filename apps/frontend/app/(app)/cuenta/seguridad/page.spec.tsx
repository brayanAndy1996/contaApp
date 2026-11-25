import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../../../lib/sesion";
import {
  MENSAJES,
  crearRouterFalso,
  destinos,
  instalarFetchFalso,
  type Manejador,
} from "../../../../pruebas/soporte";
import {
  confirmarTotpSchema,
  desactivarTotpSchema,
  enrolarTotpSchema,
  regenerarRecuperacionSchema,
} from "@contapp/shared";
import {
  CODIGOS_RECUPERACION,
  MENSAJES_SEG,
  SECRETO_CANARIO,
  URI_CANARIO,
  errorSeg,
  respuestaCodigos,
  respuestaEnrolar,
  sesionSegura,
  sesionesCuenta,
  type OpcionesSesion,
} from "../../../../pruebas/seguridad";

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
  usePathname: () => "/cuenta/seguridad",
  useSearchParams: () => new URLSearchParams(),
}));

// El QR se dibuja en el navegador con `qrcode` (dependencia que añade T6). Aquí se simula: la pantalla debe
// pedir `toDataURL(uri)` y pintar el resultado en un <img>; nada más del URI llega al DOM.
const qr = vi.hoisted(() => ({
  toDataURL: vi.fn(
    async (_texto: string) => "data:image/png;base64,QRSIMULADO",
  ),
  toString: vi.fn(async (_texto: string) => "<svg></svg>"),
}));
vi.mock("qrcode", () => ({ ...qr, default: qr }));

import Seguridad from "./page";

// Contrato (plan 029, Contratos HTTP; Alcance «Enrolar», «Desactivar», «Sesiones (RF-014)»; CA-1, CA-5, CA-6).
// Pantalla /cuenta/seguridad dentro de (app). Lee `GET /api/auth/sesion` (`totpActivo`, `factorExigido`) y
// `GET /api/auth/sesiones`. Todas las llamadas con sesión llevan X-CSRF-Token y X-Estudio (las pone `api()`);
// las que pueden dar 401 por datos erróneos usan `manejar401: false` (sin reintento ni /login).
//
// Sin TOTP: título «Seguridad» y botón «Activar la verificación en dos pasos» → campo «Contraseña actual»
//   (password) + «Continuar» → `POST /auth/totp/enrolar { contrasena }`. 200 `{ uri }` → <img> con nombre
//   accesible /código qr/i hecho con `qrcode.toDataURL(uri)`, y campo «Código de verificación» + «Confirmar»
//   → `POST /auth/totp/confirmar { codigo }`. El URI NO se escribe en el DOM, el almacenamiento ni la consola.
//   401 → MENSAJES_SEG.contrasenaIncorrecta. Confirmar con error → MENSAJES_SEG.codigoIncorrecto (429 →
//   demasiados intentos) y se conserva el QR para reintentar.
//   200 `{ codigosRecuperacion }` → se vuelve a leer la sesión (token rotado), desaparece el QR y se muestran
//   UNA vez los 10 códigos con el botón «Ya guardé mis códigos» que los quita; nada se persiste.
// Con TOTP: «La verificación en dos pasos está activa.» y dos acciones que abren su formulario (uno a la vez,
//   campos «Contraseña actual» y «Código de verificación»):
//   - «Desactivar la verificación en dos pasos» → «Confirmar desactivación» → `POST /auth/totp/desactivar
//     { contrasena, codigo }`; 204 → MENSAJES_SEG.desactivada y relee la sesión; 409 `totp_exigido` →
//     MENSAJES_SEG.totpExigido; 401 → MENSAJES_SEG.contrasenaOCodigo. Con `factorExigido` el botón no existe.
//   - «Generar códigos de recuperación nuevos» → «Generar códigos» → `POST /auth/totp/recuperacion
//     { contrasena, codigo }`; 200 `{ codigosRecuperacion }` → se muestran una vez; 401 → contrasenaOCodigo.
// Con `factorExigido` y sin TOTP: aviso MENSAJES_SEG.exigidoAviso.
// Sesiones: lista de `GET /auth/sesiones` (dispositivo, ip); la actual lleva «Esta sesión» y no tiene botón;
//   cada otra tiene un botón con aria-label «Revocar la sesión de {dispositivo}» → `POST
//   /auth/sesiones/:id/revocar` (204) y recarga la lista; «Revocar las demás sesiones» → `POST
//   /auth/sesiones/revocar-otras`; si falla (500) → MENSAJES_SEG.errorRevocar.

const ESTUDIO = { id: "e-1", nombre: "Estudio Uno" };
const CONTRASENA = "canario-contrasena-actual-123";
const CODIGO = "492817";
const ACTIVAR = "Activar la verificación en dos pasos";
const DESACTIVAR = "Desactivar la verificación en dos pasos";
const REGENERAR = "Generar códigos de recuperación nuevos";

const ID_1 = "7b9f0a52-3c1e-4d6a-9a43-5f0c2b7e8d11";
const ID_2 = "0d4c8e17-5b2a-4f3e-8c61-9a7b3d2e1f40";

const SESIONES = sesionesCuenta([
  {
    id: ID_1,
    creadaEn: "2026-11-20T10:00:00.000Z",
    ultimoUso: "2026-11-25T09:00:00.000Z",
    dispositivo: "Chrome en Windows",
    ip: "190.12.34.0/24",
    actual: true,
  },
  {
    id: ID_2,
    creadaEn: "2026-11-21T08:00:00.000Z",
    ultimoUso: "2026-11-24T18:30:00.000Z",
    dispositivo: "Safari en iPhone",
    ip: "181.65.1.0/24",
    actual: false,
  },
]);

interface Servidor {
  sesion: OpcionesSesion;
  sesiones: typeof SESIONES;
}

/** Rutas base con estado: la sesión y la lista se leen del `Servidor` en cada petición. */
function rutas(
  servidor: Servidor,
  extra: Record<string, Manejador> = {},
): Record<string, Manejador> {
  return {
    "GET /api/auth/sesion": (_l, vez) => ({
      status: 200,
      cuerpo: sesionSegura({
        estudio: ESTUDIO,
        csrf: `csrf-canario-${vez}`,
        ...servidor.sesion,
      }),
    }),
    "GET /api/auth/sesiones": () => ({
      status: 200,
      cuerpo: servidor.sesiones,
    }),
    ...extra,
  };
}

const sinTotp = (): Servidor => ({
  sesion: { factor: "sin_factor", totpActivo: false },
  sesiones: [...SESIONES],
});
const conTotp = (sesion: OpcionesSesion = {}): Servidor => ({
  sesion: { factor: "verificado", totpActivo: true, ...sesion },
  sesiones: [...SESIONES],
});

async function iniciarEnrolamiento(contrasena = CONTRASENA) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: ACTIVAR }));
  const campo = screen.getByLabelText("Contraseña actual");
  expect(campo.getAttribute("type")).toBe("password");
  await user.type(campo, contrasena);
  await user.click(screen.getByRole("button", { name: "Continuar" }));
  return user;
}

async function abrirFormulario(accion: string, enviar: string) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: accion }));
  await user.type(screen.getByLabelText("Contraseña actual"), CONTRASENA);
  await user.type(screen.getByLabelText("Código de verificación"), CODIGO);
  await user.click(screen.getByRole("button", { name: enviar }));
  return user;
}

function codigosVisibles(): number {
  return CODIGOS_RECUPERACION.filter((c) => screen.queryByText(c) !== null)
    .length;
}

describe("/cuenta/seguridad (029)", () => {
  let asignar: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    qr.toDataURL.mockClear();
    qr.toString.mockClear();
    reiniciarSesion();
    window.localStorage.clear();
    window.sessionStorage.clear();
    asignar = vi.fn();
    vi.stubGlobal("location", {
      ...window.location,
      pathname: "/cuenta/seguridad",
      assign: asignar,
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("enrolar", () => {
    it("sin TOTP: título «Seguridad» y el botón para activar; todavía sin QR ni campo de código", async () => {
      instalarFetchFalso(rutas(sinTotp()));
      render(<Seguridad />);
      expect(await screen.findByRole("button", { name: ACTIVAR })).toBeTruthy();
      expect(screen.getByRole("heading", { name: "Seguridad" })).toBeTruthy();
      expect(screen.queryByRole("img", { name: /código qr/i })).toBeNull();
      expect(screen.queryByLabelText("Código de verificación")).toBeNull();
      expect(screen.queryByRole("button", { name: DESACTIVAR })).toBeNull();
    });

    it("pide la contraseña actual (campo password) y envía POST /totp/enrolar { contrasena } con CSRF y estudio", async () => {
      const f = instalarFetchFalso(
        rutas(sinTotp(), {
          "POST /api/auth/totp/enrolar": {
            status: 200,
            cuerpo: respuestaEnrolar(),
          },
        }),
      );
      render(<Seguridad />);
      await iniciarEnrolamiento();
      await vi.waitFor(() =>
        expect(f.de("POST /api/auth/totp/enrolar")).toHaveLength(1),
      );
      const [llamada] = f.de("POST /api/auth/totp/enrolar");
      expect(llamada?.body).toEqual({ contrasena: CONTRASENA });
      expect(enrolarTotpSchema.safeParse(llamada?.body).success).toBe(true);
      expect(llamada?.credentials).toBe("same-origin");
      expect(llamada?.headers["x-csrf-token"]).toBe("csrf-canario-1");
      expect(llamada?.headers["x-estudio"]).toBe(ESTUDIO.id);
    });

    it("200 { uri } → QR en un <img> (toDataURL(uri)) y campo de código; el URI no queda en el DOM, almacenamiento ni consola", async () => {
      const espias = (["log", "info", "warn", "error", "debug"] as const).map(
        (m) => vi.spyOn(console, m).mockImplementation(() => {}),
      );
      instalarFetchFalso(
        rutas(sinTotp(), {
          "POST /api/auth/totp/enrolar": {
            status: 200,
            cuerpo: respuestaEnrolar(),
          },
        }),
      );
      const { container } = render(<Seguridad />);
      await iniciarEnrolamiento();
      const imagen = await screen.findByRole("img", { name: /código qr/i });
      expect(imagen.getAttribute("src")).toBe(
        "data:image/png;base64,QRSIMULADO",
      );
      expect(qr.toDataURL).toHaveBeenCalledWith(URI_CANARIO, expect.anything());
      expect(screen.getByLabelText("Código de verificación")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Confirmar" })).toBeTruthy();
      const html = container.innerHTML;
      const almacenado = JSON.stringify([
        { ...window.localStorage },
        { ...window.sessionStorage },
      ]);
      const consola = JSON.stringify(espias.flatMap((e) => e.mock.calls));
      for (const secreto of [URI_CANARIO, CONTRASENA]) {
        expect(html).not.toContain(secreto);
        expect(almacenado).not.toContain(secreto);
        expect(consola).not.toContain(secreto);
        expect(window.location.href).not.toContain(secreto);
      }
      expect(html).not.toContain("otpauth://");
      expect(almacenado).not.toContain(SECRETO_CANARIO);
    });

    it("401 credenciales_invalidas → mensaje propio, sin QR, sin reintento y sin ir a /login", async () => {
      const f = instalarFetchFalso(
        rutas(sinTotp(), {
          "POST /api/auth/totp/enrolar": {
            status: 401,
            cuerpo: { codigo: "credenciales_invalidas" },
          },
        }),
      );
      render(<Seguridad />);
      await iniciarEnrolamiento("no-es-la-actual-Zz9-canario");
      expect(
        await screen.findByText(MENSAJES_SEG.contrasenaIncorrecta),
      ).toBeTruthy();
      expect(screen.queryByRole("img", { name: /código qr/i })).toBeNull();
      expect(f.de("POST /api/auth/totp/enrolar")).toHaveLength(1);
      expect(asignar).not.toHaveBeenCalled();
      expect(destinos(router)).not.toContain("/login");
    });

    it("con factorExigido y sin TOTP muestra el aviso de que la verificación es obligatoria", async () => {
      instalarFetchFalso(
        rutas({
          sesion: {
            factor: "sin_factor",
            totpActivo: false,
            factorExigido: true,
          },
          sesiones: [...SESIONES],
        }),
      );
      render(<Seguridad />);
      expect(await screen.findByText(MENSAJES_SEG.exigidoAviso)).toBeTruthy();
      expect(screen.getByRole("button", { name: ACTIVAR })).toBeTruthy();
    });

    it("sin factorExigido no muestra el aviso de obligatoriedad", async () => {
      instalarFetchFalso(rutas(sinTotp()));
      render(<Seguridad />);
      await screen.findByRole("button", { name: ACTIVAR });
      expect(screen.queryByText(MENSAJES_SEG.exigidoAviso)).toBeNull();
    });
  });

  describe("confirmar y códigos de recuperación", () => {
    const CONFIRMAR = "POST /api/auth/totp/confirmar";

    function enrolable(servidor: Servidor, confirmar: Manejador) {
      return rutas(servidor, {
        "POST /api/auth/totp/enrolar": {
          status: 200,
          cuerpo: respuestaEnrolar(),
        },
        [CONFIRMAR]: confirmar,
      });
    }
    /** Al confirmar el servidor rota la sesión y la deja verificada con TOTP activo. */
    function confirmaYActiva(servidor: Servidor): Manejador {
      return () => {
        servidor.sesion = { factor: "verificado", totpActivo: true };
        return { status: 200, cuerpo: respuestaCodigos() };
      };
    }
    async function hastaConfirmar(codigo = CODIGO) {
      const user = await iniciarEnrolamiento();
      await user.type(
        await screen.findByLabelText("Código de verificación"),
        codigo,
      );
      await user.click(screen.getByRole("button", { name: "Confirmar" }));
      return user;
    }

    it("envía POST /totp/confirmar { codigo } con CSRF y estudio", async () => {
      const servidor = sinTotp();
      const f = instalarFetchFalso(
        enrolable(servidor, confirmaYActiva(servidor)),
      );
      render(<Seguridad />);
      await hastaConfirmar();
      await vi.waitFor(() => expect(f.de(CONFIRMAR)).toHaveLength(1));
      const [llamada] = f.de(CONFIRMAR);
      expect(llamada?.body).toEqual({ codigo: CODIGO });
      expect(confirmarTotpSchema.safeParse(llamada?.body).success).toBe(true);
      expect(llamada?.headers["x-csrf-token"]).toBeTruthy();
      expect(llamada?.headers["x-estudio"]).toBe(ESTUDIO.id);
    });

    it("200 → muestra los 10 códigos una vez, quita el QR y vuelve a leer la sesión (token rotado)", async () => {
      const servidor = sinTotp();
      const f = instalarFetchFalso(
        enrolable(servidor, confirmaYActiva(servidor)),
      );
      render(<Seguridad />);
      await hastaConfirmar();
      await vi.waitFor(() => expect(codigosVisibles()).toBe(10));
      expect(screen.queryByRole("img", { name: /código qr/i })).toBeNull();
      const orden = f.llamadas.map((l) => `${l.method} ${l.ruta}`);
      const iPost = orden.indexOf(CONFIRMAR);
      expect(iPost).toBeGreaterThan(-1);
      expect(orden.slice(iPost + 1)).toContain("GET /api/auth/sesion");
      // Siguen a la vista aunque la sesión ya diga «activa».
      expect(codigosVisibles()).toBe(10);
    });

    it("«Ya guardé mis códigos» los quita y no se guardan en almacenamiento ni consola; al remontar no vuelven", async () => {
      const espias = (["log", "info", "warn", "error", "debug"] as const).map(
        (m) => vi.spyOn(console, m).mockImplementation(() => {}),
      );
      const servidor = sinTotp();
      instalarFetchFalso(enrolable(servidor, confirmaYActiva(servidor)));
      const { unmount } = render(<Seguridad />);
      const user = await hastaConfirmar();
      await vi.waitFor(() => expect(codigosVisibles()).toBe(10));
      const almacenado = JSON.stringify([
        { ...window.localStorage },
        { ...window.sessionStorage },
      ]);
      const consola = JSON.stringify(espias.flatMap((e) => e.mock.calls));
      for (const codigo of CODIGOS_RECUPERACION) {
        expect(almacenado).not.toContain(codigo);
        expect(consola).not.toContain(codigo);
      }
      await user.click(
        screen.getByRole("button", { name: "Ya guardé mis códigos" }),
      );
      expect(codigosVisibles()).toBe(0);
      unmount();
      render(<Seguridad />);
      await screen.findByText("La verificación en dos pasos está activa.");
      expect(codigosVisibles()).toBe(0);
    });

    it.each([400, 401])(
      "%i codigo_invalido → mensaje de código incorrecto, sin códigos, el QR sigue y no hay reintento ni /login",
      async (status) => {
        const f = instalarFetchFalso(
          enrolable(sinTotp(), { status, cuerpo: errorSeg("codigo_invalido") }),
        );
        render(<Seguridad />);
        await hastaConfirmar("000000");
        expect(
          await screen.findByText(MENSAJES_SEG.codigoIncorrecto),
        ).toBeTruthy();
        expect(codigosVisibles()).toBe(0);
        expect(screen.getByRole("img", { name: /código qr/i })).toBeTruthy();
        expect(f.de(CONFIRMAR)).toHaveLength(1);
        expect(asignar).not.toHaveBeenCalled();
        expect(destinos(router)).not.toContain("/login");
      },
    );

    it("429 demasiados_intentos → mensaje de demasiados intentos", async () => {
      instalarFetchFalso(
        enrolable(sinTotp(), {
          status: 429,
          cuerpo: { codigo: "demasiados_intentos" },
        }),
      );
      render(<Seguridad />);
      await hastaConfirmar();
      expect(await screen.findByText(MENSAJES.demasiadosIntentos)).toBeTruthy();
      expect(screen.queryByText(MENSAJES_SEG.codigoIncorrecto)).toBeNull();
      expect(codigosVisibles()).toBe(0);
    });
  });

  describe("con TOTP activo", () => {
    const ACTIVA = "La verificación en dos pasos está activa.";

    it("muestra que está activa, ofrece desactivar y regenerar, y ya no ofrece activar", async () => {
      instalarFetchFalso(rutas(conTotp()));
      render(<Seguridad />);
      expect(await screen.findByText(ACTIVA)).toBeTruthy();
      expect(screen.getByRole("button", { name: DESACTIVAR })).toBeTruthy();
      expect(screen.getByRole("button", { name: REGENERAR })).toBeTruthy();
      expect(screen.queryByRole("button", { name: ACTIVAR })).toBeNull();
    });

    it("con factorExigido NO ofrece desactivar (sí regenerar)", async () => {
      instalarFetchFalso(rutas(conTotp({ factorExigido: true })));
      render(<Seguridad />);
      await screen.findByText(ACTIVA);
      expect(screen.queryByRole("button", { name: DESACTIVAR })).toBeNull();
      expect(screen.getByRole("button", { name: REGENERAR })).toBeTruthy();
    });

    it("desactivar: POST /totp/desactivar { contrasena, codigo }; 204 → mensaje, relee la sesión y vuelve a ofrecer activar", async () => {
      const servidor = conTotp();
      const f = instalarFetchFalso(
        rutas(servidor, {
          "POST /api/auth/totp/desactivar": (_l) => {
            servidor.sesion = { factor: "sin_factor", totpActivo: false };
            return { status: 204 };
          },
        }),
      );
      render(<Seguridad />);
      await abrirFormulario(DESACTIVAR, "Confirmar desactivación");
      expect(await screen.findByText(MENSAJES_SEG.desactivada)).toBeTruthy();
      const [llamada] = f.de("POST /api/auth/totp/desactivar");
      expect(llamada?.body).toEqual({ contrasena: CONTRASENA, codigo: CODIGO });
      expect(desactivarTotpSchema.safeParse(llamada?.body).success).toBe(true);
      expect(llamada?.headers["x-csrf-token"]).toBeTruthy();
      expect(llamada?.headers["x-estudio"]).toBe(ESTUDIO.id);
      expect(await screen.findByRole("button", { name: ACTIVAR })).toBeTruthy();
      const orden = f.llamadas.map((l) => `${l.method} ${l.ruta}`);
      expect(
        orden.slice(orden.indexOf("POST /api/auth/totp/desactivar") + 1),
      ).toContain("GET /api/auth/sesion");
    });

    it("desactivar 409 totp_exigido → mensaje de que el rol lo exige; sigue activa", async () => {
      instalarFetchFalso(
        rutas(conTotp(), {
          "POST /api/auth/totp/desactivar": {
            status: 409,
            cuerpo: errorSeg("totp_exigido"),
          },
        }),
      );
      render(<Seguridad />);
      await abrirFormulario(DESACTIVAR, "Confirmar desactivación");
      expect(await screen.findByText(MENSAJES_SEG.totpExigido)).toBeTruthy();
      expect(screen.queryByText(MENSAJES_SEG.desactivada)).toBeNull();
      expect(screen.queryByRole("button", { name: ACTIVAR })).toBeNull();
    });

    it("desactivar 401 → mensaje único de contraseña o código incorrectos, sin ir a /login", async () => {
      const f = instalarFetchFalso(
        rutas(conTotp(), {
          "POST /api/auth/totp/desactivar": {
            status: 401,
            cuerpo: { codigo: "credenciales_invalidas" },
          },
        }),
      );
      render(<Seguridad />);
      await abrirFormulario(DESACTIVAR, "Confirmar desactivación");
      expect(
        await screen.findByText(MENSAJES_SEG.contrasenaOCodigo),
      ).toBeTruthy();
      expect(f.de("POST /api/auth/totp/desactivar")).toHaveLength(1);
      expect(asignar).not.toHaveBeenCalled();
      expect(destinos(router)).not.toContain("/login");
    });

    it("regenerar: POST /totp/recuperacion { contrasena, codigo }; 200 → muestra los 10 códigos una vez", async () => {
      const f = instalarFetchFalso(
        rutas(conTotp(), {
          "POST /api/auth/totp/recuperacion": {
            status: 200,
            cuerpo: respuestaCodigos(),
          },
        }),
      );
      render(<Seguridad />);
      const user = await abrirFormulario(REGENERAR, "Generar códigos");
      await vi.waitFor(() => expect(codigosVisibles()).toBe(10));
      const [llamada] = f.de("POST /api/auth/totp/recuperacion");
      expect(llamada?.body).toEqual({ contrasena: CONTRASENA, codigo: CODIGO });
      expect(regenerarRecuperacionSchema.safeParse(llamada?.body).success).toBe(
        true,
      );
      expect(llamada?.headers["x-csrf-token"]).toBeTruthy();
      await user.click(
        screen.getByRole("button", { name: "Ya guardé mis códigos" }),
      );
      expect(codigosVisibles()).toBe(0);
    });

    it("regenerar 401 → mensaje único y ningún código", async () => {
      instalarFetchFalso(
        rutas(conTotp(), {
          "POST /api/auth/totp/recuperacion": {
            status: 401,
            cuerpo: { codigo: "credenciales_invalidas" },
          },
        }),
      );
      render(<Seguridad />);
      await abrirFormulario(REGENERAR, "Generar códigos");
      expect(
        await screen.findByText(MENSAJES_SEG.contrasenaOCodigo),
      ).toBeTruthy();
      expect(codigosVisibles()).toBe(0);
    });
  });

  describe("sesiones activas (RF-014)", () => {
    it("lista las sesiones con su dispositivo; la actual dice «Esta sesión» y no se puede revocar", async () => {
      instalarFetchFalso(rutas(conTotp()));
      render(<Seguridad />);
      const actual = (await screen.findByText("Chrome en Windows")).closest(
        "li",
      );
      const otra = screen.getByText("Safari en iPhone").closest("li");
      expect(actual).toBeTruthy();
      expect(otra).toBeTruthy();
      expect(
        within(actual as HTMLElement).getByText("Esta sesión"),
      ).toBeTruthy();
      expect(within(otra as HTMLElement).queryByText("Esta sesión")).toBeNull();
      expect(
        screen.queryByRole("button", {
          name: "Revocar la sesión de Chrome en Windows",
        }),
      ).toBeNull();
      expect(
        screen.getByRole("button", {
          name: "Revocar la sesión de Safari en iPhone",
        }),
      ).toBeTruthy();
    });

    it("revocar una: POST /sesiones/:id/revocar con CSRF y recarga la lista sin esa sesión", async () => {
      const servidor = conTotp();
      const f = instalarFetchFalso(
        rutas(servidor, {
          [`POST /api/auth/sesiones/${ID_2}/revocar`]: () => {
            servidor.sesiones = servidor.sesiones.filter((s) => s.id !== ID_2);
            return { status: 204 };
          },
        }),
      );
      render(<Seguridad />);
      const user = userEvent.setup();
      await user.click(
        await screen.findByRole("button", {
          name: "Revocar la sesión de Safari en iPhone",
        }),
      );
      await vi.waitFor(() =>
        expect(screen.queryByText("Safari en iPhone")).toBeNull(),
      );
      expect(screen.getByText("Chrome en Windows")).toBeTruthy();
      const [llamada] = f.de(`POST /api/auth/sesiones/${ID_2}/revocar`);
      expect(llamada?.headers["x-csrf-token"]).toBeTruthy();
      expect(llamada?.headers["x-estudio"]).toBe(ESTUDIO.id);
      expect(f.de("GET /api/auth/sesiones").length).toBeGreaterThanOrEqual(2);
    });

    it("«Revocar las demás sesiones»: POST /sesiones/revocar-otras y recarga; queda solo la actual", async () => {
      const servidor = conTotp();
      const f = instalarFetchFalso(
        rutas(servidor, {
          "POST /api/auth/sesiones/revocar-otras": () => {
            servidor.sesiones = servidor.sesiones.filter((s) => s.actual);
            return { status: 204 };
          },
        }),
      );
      render(<Seguridad />);
      const user = userEvent.setup();
      await user.click(
        await screen.findByRole("button", {
          name: "Revocar las demás sesiones",
        }),
      );
      await vi.waitFor(() =>
        expect(screen.queryByText("Safari en iPhone")).toBeNull(),
      );
      expect(screen.getByText("Chrome en Windows")).toBeTruthy();
      expect(f.de("POST /api/auth/sesiones/revocar-otras")).toHaveLength(1);
      expect(
        f.de("POST /api/auth/sesiones/revocar-otras")[0]?.headers[
          "x-csrf-token"
        ],
      ).toBeTruthy();
    });

    it("si la revocación falla (500) avisa y conserva la lista", async () => {
      instalarFetchFalso(
        rutas(conTotp(), {
          [`POST /api/auth/sesiones/${ID_2}/revocar`]: {
            status: 500,
            cuerpo: { codigo: "error" },
          },
        }),
      );
      render(<Seguridad />);
      const user = userEvent.setup();
      await user.click(
        await screen.findByRole("button", {
          name: "Revocar la sesión de Safari en iPhone",
        }),
      );
      expect(await screen.findByText(MENSAJES_SEG.errorRevocar)).toBeTruthy();
      expect(screen.getByText("Safari en iPhone")).toBeTruthy();
    });

    it("no muestra tokens ni hashes aunque la respuesta traiga campos de más", async () => {
      instalarFetchFalso(
        rutas({
          sesion: { factor: "verificado", totpActivo: true },
          // Respuesta defectuosa (fuera del esquema estricto): la pantalla no debe pintar el campo de más.
          sesiones: SESIONES.map((s) => ({
            ...s,
            tokenHash: "hash-canario-no-mostrar",
          })) as unknown as typeof SESIONES,
        }),
      );
      const { container } = render(<Seguridad />);
      await screen.findByText("Chrome en Windows");
      expect(container.innerHTML).not.toContain("hash-canario-no-mostrar");
    });
  });
});

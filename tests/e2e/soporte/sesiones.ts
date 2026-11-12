// Sesiones por API (spec 018, D-4; plan «Soporte»): `POST /auth/login` (y `/auth/estudio` si hace falta) contra
// el backend, con `Origin` del frontend y un `X-Forwarded-For` propio por sesión, como `ipUnica()` de
// `apps/backend/test/soporte.ts`: `login_ip` admite 20 intentos cada 10 min por IP y `registro_ip` 5 por hora,
// así que con `--repeat-each=3` y 4 workers una IP compartida se agotaría. Sin proyecto `setup`.
// Nunca registra ni devuelve la contraseña ni el valor de la cookie en un mensaje de error.
import { randomBytes } from "node:crypto";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { URL_BACKEND, URL_FRONTEND } from "./pila/entorno.js";
import type { Usuario } from "./siembra.js";
import type { Vigilancia } from "./vigilancia.js";

export const NOMBRE_COOKIE = "__Host-contapp_sid";

let contador = 0;

/** IP privada aleatoria: `auth.limite_tasa` persiste 10 min entre corridas, así que un contador no basta. */
export function ipUnica(): string {
  contador += 1;
  const r = randomBytes(3);
  return `10.${((r[0] ?? 0) + contador) & 255}.${r[1] ?? 1}.${((r[2] ?? 1) % 250) + 1}`;
}

export interface CookieEstado {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

export interface EstadoAlmacenado {
  cookies: CookieEstado[];
  origins: [];
}

export interface Sesion {
  readonly usuario: Usuario;
  readonly tenantId: string;
  /** El `X-Forwarded-For` de esta sesión; el navegador lo manda igual para no compartir cupo. */
  readonly ip: string;
  /** `__Host-contapp_sid=<valor>`, listo para la cabecera `Cookie`. */
  readonly cookie: string;
  readonly csrf: string;
  readonly storageState: EstadoAlmacenado;
}

function leerCookie(respuesta: Response): CookieEstado {
  const linea = respuesta.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${NOMBRE_COOKIE}=`));
  if (linea === undefined)
    throw new Error("El login no devolvió la cookie de sesión.");
  const [par, ...atributos] = linea.split(";").map((p) => p.trim());
  const valor = (par ?? "").slice(NOMBRE_COOKIE.length + 1);
  const atributo = (nombre: string): string | undefined =>
    atributos
      .find((a) => a.toLowerCase().startsWith(`${nombre.toLowerCase()}=`))
      ?.split("=")[1];
  const maxAge = Number(atributo("max-age"));
  const sameSite = (atributo("samesite") ?? "Lax").toLowerCase();
  return {
    name: NOMBRE_COOKIE,
    value: valor,
    domain: "localhost",
    path: "/",
    expires:
      Number.isFinite(maxAge) && maxAge > 0
        ? Math.floor(Date.now() / 1000) + maxAge
        : -1,
    httpOnly: true,
    secure: true,
    sameSite:
      sameSite === "strict" ? "Strict" : sameSite === "none" ? "None" : "Lax",
  };
}

function cabecerasBase(ip: string, cookie?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Origin: URL_FRONTEND,
    "X-Forwarded-For": ip,
    ...(cookie === undefined ? {} : { Cookie: cookie }),
  };
}

async function csrfDe(cookie: string, ip: string): Promise<string> {
  const r = await fetch(`${URL_BACKEND}/auth/sesion`, {
    headers: cabecerasBase(ip, cookie),
  });
  if (r.status !== 200)
    throw new Error(`GET /auth/sesion respondió ${r.status}.`);
  const cuerpo = (await r.json()) as { csrf?: string };
  if (typeof cuerpo.csrf !== "string")
    throw new Error("La sesión no trae csrf.");
  return cuerpo.csrf;
}

/**
 * Inicia sesión por API y la deja en el estudio `tenantId` (por defecto, el del usuario). Con un solo
 * estudio el login ya lo activa; con varios, o si se pide otro, se cambia con `/auth/estudio`.
 */
export async function entrar(
  usuario: Usuario,
  tenantId: string = usuario.tenantId,
  ip: string = ipUnica(),
): Promise<Sesion> {
  const login = await fetch(`${URL_BACKEND}/auth/login`, {
    method: "POST",
    headers: cabecerasBase(ip),
    body: JSON.stringify({
      correo: usuario.correo,
      contrasena: usuario.contrasena,
    }),
  });
  if (login.status !== 200) {
    throw new Error(`El login de prueba respondió ${login.status}.`);
  }
  const activo = (
    (await login.json()) as { estudioActivo: { id: string } | null }
  ).estudioActivo;
  let galleta = leerCookie(login);
  if (activo?.id !== tenantId) {
    const csrfPrevio = await csrfDe(`${NOMBRE_COOKIE}=${galleta.value}`, ip);
    const cambio = await fetch(`${URL_BACKEND}/auth/estudio`, {
      method: "POST",
      headers: {
        ...cabecerasBase(ip, `${NOMBRE_COOKIE}=${galleta.value}`),
        "X-CSRF-Token": csrfPrevio,
      },
      body: JSON.stringify({ tenantId }),
    });
    if (cambio.status !== 200) {
      throw new Error(
        `El cambio de estudio de prueba respondió ${cambio.status}.`,
      );
    }
    galleta = leerCookie(cambio);
  }
  const cookie = `${NOMBRE_COOKIE}=${galleta.value}`;
  const csrf = await csrfDe(cookie, ip);
  return {
    usuario,
    tenantId,
    ip,
    cookie,
    csrf,
    storageState: { cookies: [galleta], origins: [] },
  };
}

export interface PaginaAbierta {
  readonly page: Page;
  readonly context: BrowserContext;
  readonly sesion: Sesion;
}

/**
 * Abre un contexto de navegador nuevo ya con la sesión de `usuario` (otra persona, otro estudio). Lleva su
 * propio `X-Forwarded-For`. Si hay `vigilancia`, el contexto queda vigilado como el de la prueba.
 */
export async function abrirPagina(
  browser: Browser,
  usuario: Usuario,
  tenantId: string = usuario.tenantId,
  vigilancia?: Vigilancia,
): Promise<PaginaAbierta> {
  const sesion = await entrar(usuario, tenantId);
  const context = await browser.newContext({
    storageState: sesion.storageState,
    extraHTTPHeaders: { "X-Forwarded-For": sesion.ip },
  });
  await vigilancia?.observarContexto(context);
  const page = await context.newPage();
  return { page, context, sesion };
}

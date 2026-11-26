// Segundo paso del login por API (spec 029, T11): contraseña → sesión `pendiente` → `POST /auth/2fa/verificar`, con las cabeceras del
// navegador (`Origin`, IP propia). La sesión `pendiente` no puede leer `GET /auth/sesion`, así que el `X-CSRF-Token` (D6) se deriva
// del valor de la cookie como lo hace `apps/backend/src/modules/auth/sesion/csrf.ts`; solo se usa aquí, para probar el contrato
// del servidor (replay, ventana, código de recuperación) sin pasar por la pantalla.
import { createHash } from "node:crypto";
import { URL_BACKEND, URL_FRONTEND } from "./pila/entorno.js";
import { NOMBRE_COOKIE, ipUnica } from "./sesiones.js";

export interface Pendiente {
  readonly cookie: string;
  readonly ip: string;
}

export interface Respuesta {
  readonly status: number;
  readonly cuerpo: Record<string, unknown> | null;
  /** `__Host-contapp_sid=<valor>` si la respuesta trae la cookie nueva. */
  readonly cookie: string | null;
}

const cabeceras = (ip: string, cookie?: string): Record<string, string> => ({
  "Content-Type": "application/json",
  Origin: URL_FRONTEND,
  "X-Forwarded-For": ip,
  ...(cookie === undefined ? {} : { Cookie: cookie }),
});

function cookieDe(r: Response): string | null {
  const linea = r.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${NOMBRE_COOKIE}=`));
  const valor = linea?.split(";")[0]?.trim();
  return valor === undefined ? null : valor;
}

async function leer(r: Response): Promise<Respuesta> {
  const cuerpo = (await r.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  return { status: r.status, cuerpo, cookie: cookieDe(r) };
}

const csrfDeCookie = (cookie: string): string =>
  createHash("sha256")
    .update(`contapp-csrf|v1|${cookie.slice(NOMBRE_COOKIE.length + 1)}`, "utf8")
    .digest("base64url");

/** Login con contraseña de quien tiene TOTP activo: la API responde `segundoFactor: true` y deja una sesión `pendiente`. */
export async function loginPendiente(
  correo: string,
  contrasena: string,
): Promise<Pendiente & Respuesta> {
  const ip = ipUnica();
  const r = await leer(
    await fetch(`${URL_BACKEND}/auth/login`, {
      method: "POST",
      headers: cabeceras(ip),
      body: JSON.stringify({ correo, contrasena }),
    }),
  );
  if (r.status !== 200 || r.cookie === null)
    throw new Error(`El login de prueba respondió ${r.status}.`);
  return { ...r, cookie: r.cookie, ip };
}

/** `POST /auth/2fa/verificar` con `{codigo}` o `{codigoRecuperacion}`. */
export async function verificarSegundoPaso(
  p: Pendiente,
  cuerpo: { codigo: string } | { codigoRecuperacion: string },
): Promise<Respuesta> {
  return leer(
    await fetch(`${URL_BACKEND}/auth/2fa/verificar`, {
      method: "POST",
      headers: {
        ...cabeceras(p.ip, p.cookie),
        "X-CSRF-Token": csrfDeCookie(p.cookie),
      },
      body: JSON.stringify(cuerpo),
    }),
  );
}

/** `GET` con una cookie de sesión concreta, directo a la API. */
export async function obtener(
  p: Pendiente,
  ruta: string,
  estudioId?: string,
): Promise<Respuesta> {
  return leer(
    await fetch(`${URL_BACKEND}${ruta}`, {
      headers: {
        ...cabeceras(p.ip, p.cookie),
        ...(estudioId === undefined ? {} : { "X-Estudio": estudioId }),
      },
    }),
  );
}

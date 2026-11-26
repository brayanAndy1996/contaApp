// Segundo paso del login por API (spec 029, T11): contraseña → sesión `pendiente` → `POST /auth/2fa/verificar`, con las cabeceras del
// navegador (`Origin`, IP propia). La sesión `pendiente` no puede leer `GET /auth/sesion`, así que el `X-CSRF-Token` (D6) es el `csrf`
// que trae la respuesta del login (T11b); no se deriva aquí, para probar el contrato real del servidor (replay, ventana, código de
// recuperación) sin pasar por la pantalla.
import { URL_BACKEND, URL_FRONTEND } from "./pila/entorno.js";
import { NOMBRE_COOKIE, ipUnica } from "./sesiones.js";

export interface Pendiente {
  readonly cookie: string;
  readonly ip: string;
  /** `csrf` de la respuesta del login pendiente. */
  readonly csrf: string;
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
  const csrf = r.cuerpo?.csrf;
  if (typeof csrf !== "string")
    throw new Error("La respuesta del login pendiente no trae `csrf`.");
  return { ...r, cookie: r.cookie, ip, csrf };
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
        "X-CSRF-Token": p.csrf,
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

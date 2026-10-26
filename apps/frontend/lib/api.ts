import { obtenerSesion, reiniciarSesion } from "./sesion";

// Cliente HTTP del frontend (spec 004, CA-12). Todas las llamadas van a `/api/*` (Next las reescribe
// al backend), con la cookie de sesión del mismo origen. Añade `X-CSRF-Token` en los no-GET y
// `X-Estudio` con el estudio activo; no calcula nada de negocio.

export interface RespuestaApi<T = unknown> {
  ok: boolean;
  status: number;
  datos: T | null;
}

export interface OpcionesApi {
  method?: string;
  body?: unknown;
  /** Login y recuperación: sin consultar la sesión ni añadir cabeceras de sesión. */
  sinSesion?: boolean;
  /**
   * Por defecto (`true`) todo 401 es sesión caducada: se vacía la sesión y se va a /login. Con
   * `false` el 401 llega a la pantalla (p. ej. contraseña actual errónea), salvo que el cuerpo
   * traiga `codigo: "sesion_invalida"`, que sigue siendo sesión caducada.
   */
  manejar401?: boolean;
}

/** Evento de `window` cuando el estudio de la pestaña quedó desfasado (409). */
export const EVENTO_ESTUDIO_DESFASADO = "contapp:estudio-desfasado";

async function leerCuerpo(respuesta: Response): Promise<unknown> {
  const texto = await respuesta.text();
  if (!texto) return null;
  try {
    return JSON.parse(texto) as unknown;
  } catch {
    return null;
  }
}

function irALogin(): void {
  if (window.location.pathname !== "/login") window.location.assign("/login");
}

async function ejecutar<T>(
  ruta: string,
  opciones: OpcionesApi,
  reintento: boolean,
): Promise<RespuestaApi<T>> {
  const metodo = (opciones.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = {};
  if (opciones.body !== undefined) headers["Content-Type"] = "application/json";

  if (!opciones.sinSesion) {
    const sesion = await obtenerSesion();
    if (!sesion) {
      irALogin();
      return { ok: false, status: 401, datos: null };
    }
    if (sesion.estudioActivo) headers["X-Estudio"] = sesion.estudioActivo.id;
    if (metodo !== "GET") headers["X-CSRF-Token"] = sesion.csrf;
  }

  const respuesta = await fetch(`/api${ruta}`, {
    method: metodo,
    credentials: "same-origin",
    headers,
    body:
      opciones.body === undefined ? undefined : JSON.stringify(opciones.body),
  });
  const datos = await leerCuerpo(respuesta);

  if (!opciones.sinSesion) {
    if (
      respuesta.status === 401 &&
      (opciones.manejar401 !== false ||
        (datos as { codigo?: string } | null)?.codigo === "sesion_invalida")
    ) {
      reiniciarSesion();
      irALogin();
    } else if (respuesta.status === 409) {
      await obtenerSesion(true);
      window.dispatchEvent(new Event(EVENTO_ESTUDIO_DESFASADO));
    } else if (
      respuesta.status === 403 &&
      !reintento &&
      (datos as { codigo?: string } | null)?.codigo === "csrf_invalido"
    ) {
      await obtenerSesion(true);
      return ejecutar<T>(ruta, opciones, true);
    }
  }
  return { ok: respuesta.ok, status: respuesta.status, datos: datos as T | null };
}

export function api<T = unknown>(
  ruta: string,
  opciones: OpcionesApi = {},
): Promise<RespuestaApi<T>> {
  return ejecutar<T>(ruta, opciones, false);
}

import { obtenerSesion, reiniciarSesion, type Sesion } from "./sesion";

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
  /**
   * Cuerpo crudo (p. ej. el archivo de la importación): se envía tal cual, sin `JSON.stringify` y como
   * `application/octet-stream`. Excluyente con `body`.
   */
  cuerpoCrudo?: Blob | ArrayBuffer | Uint8Array;
  /** Login y recuperación: sin consultar la sesión ni añadir cabeceras de sesión. */
  sinSesion?: boolean;
  /**
   * Por defecto (`true`) todo 401 es sesión caducada: se comprueba la sesión real (una vez, por si fue
   * la rotación del cambio de estudio y se reintenta la petición una vez); si no hay sesión, se vacía
   * y se va a /login. Con
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

// Comprobación de sesión tras un 401, compartida por todas las peticiones que lo reciben a la vez.
let comprobacion401: Promise<Sesion | null> | null = null;

/**
 * Un 401 puede ser la carrera de la rotación de sesión (cambio de estudio): la petición salió con la
 * cookie vieja y el servidor ya la revocó. Se relee la sesión real una sola vez (compartida) y se
 * devuelve la sesión vigente, o `null` si de verdad caducó (o no se pudo comprobar).
 */
function comprobarSesionTras401(): Promise<Sesion | null> {
  if (comprobacion401) return comprobacion401;
  reiniciarSesion();
  const peticion = obtenerSesion(true)
    .catch(() => null)
    .finally(() => {
      if (comprobacion401 === peticion) comprobacion401 = null;
    });
  comprobacion401 = peticion;
  return peticion;
}

async function ejecutar<T>(
  ruta: string,
  opciones: OpcionesApi,
  reintento: boolean,
  reintento401 = false,
): Promise<RespuestaApi<T>> {
  const metodo = (opciones.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = {};
  if (opciones.cuerpoCrudo !== undefined)
    headers["Content-Type"] = "application/octet-stream";
  else if (opciones.body !== undefined)
    headers["Content-Type"] = "application/json";

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
      opciones.cuerpoCrudo !== undefined
        ? (opciones.cuerpoCrudo as BodyInit)
        : opciones.body === undefined
          ? undefined
          : JSON.stringify(opciones.body),
  });
  const datos = await leerCuerpo(respuesta);

  if (!opciones.sinSesion) {
    if (
      respuesta.status === 401 &&
      (opciones.manejar401 !== false ||
        (datos as { codigo?: string } | null)?.codigo === "sesion_invalida")
    ) {
      // Como mucho un reintento por petición; la propia consulta de sesión (`/auth/sesion`) no pasa
      // por aquí. Se reintenta con la sesión nueva: `X-Estudio` y el CSRF se recalculan.
      if (!reintento401 && (await comprobarSesionTras401()) !== null)
        return ejecutar<T>(ruta, opciones, reintento, true);
      reiniciarSesion();
      irALogin();
    } else if (
      respuesta.status === 409 &&
      (datos as { codigo?: string } | null)?.codigo === "estudio_desfasado"
    ) {
      // Solo el 409 de estudio desfasado (004) recarga la sesión; los 409 de negocio de 005
      // (`ultimo_dueno`, `cupo_usuarios`…) llegan tal cual a la pantalla.
      await obtenerSesion(true);
      window.dispatchEvent(new Event(EVENTO_ESTUDIO_DESFASADO));
    } else if (
      respuesta.status === 403 &&
      !reintento &&
      (datos as { codigo?: string } | null)?.codigo === "csrf_invalido"
    ) {
      await obtenerSesion(true);
      return ejecutar<T>(ruta, opciones, true, reintento401);
    }
  }
  return {
    ok: respuesta.ok,
    status: respuesta.status,
    datos: datos as T | null,
  };
}

export function api<T = unknown>(
  ruta: string,
  opciones: OpcionesApi = {},
): Promise<RespuestaApi<T>> {
  return ejecutar<T>(ruta, opciones, false);
}

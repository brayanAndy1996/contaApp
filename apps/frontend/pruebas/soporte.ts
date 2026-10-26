import { vi } from "vitest";

// Soporte común de las pruebas del frontend (spec 004, T8): fetch simulado, router simulado y
// los mensajes exactos que las pantallas deben mostrar (contrato para T13).

/** Mensajes visibles que las pruebas esperan. Genéricos a propósito (CA-2, CA-8, P3). */
export const MENSAJES = {
  // 401 de login, sea cual sea la causa (inexistente, errónea o bloqueada: P3).
  credencialesInvalidas: "Correo o contraseña incorrectos.",
  // 429 de login (límite por IP).
  demasiadosIntentos:
    "Demasiados intentos. Inténtalo de nuevo en unos minutos.",
  // Texto contenido (sin punto obligatorio) en /estudios cuando la lista viene vacía (P7).
  sinEstudios: "No perteneces a ningún estudio activo",
  // /recuperar: el mismo mensaje exista o no el correo (CA-8).
  recuperarEnviado:
    "Si el correo está registrado, te enviamos un enlace para restablecer tu contraseña.",
  // /recuperar/nueva
  contrasenaActualizada: "Tu contraseña fue actualizada.",
  tokenInvalido: "El enlace no es válido o venció. Solicita uno nuevo.",
  contrasenaLongitud: "La contraseña debe tener entre 12 y 128 caracteres.",
  contrasenaComun: "Esa contraseña es demasiado común. Elige otra.",
} as const;

/** Evento de `window` que `api()` emite ante 409 `estudio_desfasado` ("avisa", CA-12). */
export const EVENTO_ESTUDIO_DESFASADO = "contapp:estudio-desfasado";

export interface Llamada {
  /** URL tal como se pasó a fetch (relativa: `/api/...`). */
  url: string;
  /** Ruta sin query. */
  ruta: string;
  method: string;
  /** Cabeceras con nombres en minúsculas. */
  headers: Record<string, string>;
  /** Cuerpo JSON ya parseado (o `undefined`). */
  body: unknown;
  credentials: RequestCredentials | undefined;
}

export interface RespuestaSimulada {
  status: number;
  cuerpo?: unknown;
}

export type Manejador =
  RespuestaSimulada | ((llamada: Llamada, vez: number) => RespuestaSimulada);

export interface FetchFalso {
  llamadas: Llamada[];
  /** Llamadas a `METODO /ruta`, en orden. */
  de(clave: string): Llamada[];
}

/** Instala un `fetch` simulado. Clave de ruta: `"POST /api/auth/login"`. Ruta no simulada → error. */
export function instalarFetchFalso(
  rutas: Record<string, Manejador>,
): FetchFalso {
  const llamadas: Llamada[] = [];
  const veces = new Map<string, number>();
  const falso = vi.fn(
    async (entrada: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof entrada === "string"
          ? entrada
          : entrada instanceof URL
            ? entrada.pathname + entrada.search
            : entrada.url;
      const ruta = url.split("?")[0] ?? url;
      const method = (init?.method ?? "GET").toUpperCase();
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((valor, nombre) => {
        headers[nombre.toLowerCase()] = valor;
      });
      let body: unknown;
      if (typeof init?.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      llamadas.push({
        url,
        ruta,
        method,
        headers,
        body,
        credentials: init?.credentials,
      });
      const clave = `${method} ${ruta}`;
      const manejador = rutas[clave];
      if (!manejador) throw new Error(`ruta no simulada: ${clave}`);
      const vez = (veces.get(clave) ?? 0) + 1;
      veces.set(clave, vez);
      const r =
        typeof manejador === "function"
          ? manejador(llamadas[llamadas.length - 1]!, vez)
          : manejador;
      return new Response(
        r.status === 204 ? null : JSON.stringify(r.cuerpo ?? {}),
        { status: r.status, headers: { "content-type": "application/json" } },
      );
    },
  );
  vi.stubGlobal("fetch", falso);
  return {
    llamadas,
    de: (clave) => llamadas.filter((l) => `${l.method} ${l.ruta}` === clave),
  };
}

/** Cuerpo de `GET /auth/sesion` (contrato del plan). */
export function sesionDe(
  estudioActivo: { id: string; nombre: string } | null,
  csrf = "csrf-canario-1",
) {
  return {
    usuario: { id: "u-1", nombre: "Ana Prueba", correo: "ana@ejemplo.test" },
    estudioActivo,
    csrf,
  };
}

/** Router simulado de `next/navigation` (úsese con `vi.hoisted` + `vi.mock`). */
export function crearRouterFalso() {
  return {
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  };
}

/** Destinos a los que se navegó (push o replace), en orden. */
export function destinos(
  router: ReturnType<typeof crearRouterFalso>,
): string[] {
  return [...router.push.mock.calls, ...router.replace.mock.calls].map((c) =>
    String(c[0]),
  );
}

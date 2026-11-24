import { preferenciasCorreoVistaSchema, type PreferenciasCorreoVista } from "@contapp/shared";
import { api } from "./api";

// Avisos por correo (spec 028, T13). Cliente de `/cuenta/correo` y de `/correo/baja`, textos de las pantallas y la lista
// cerrada de pantallas de `/ir` (D-3). No calcula nada de negocio: el servidor decide qué interruptores hay (`todosDisponible`)
// y qué se guarda. Nunca se registra ni se imprime el token de baja.

export type { PreferenciasCorreoVista };

export const MENSAJES_CORREO = {
  // «Mi cuenta → Correo» (`/cuenta/correo`).
  titulo: "Correo",
  entradaMenu: "Correo",
  descripcion: "Elige qué avisos quieres recibir en tu correo de acceso.",
  cargando: "Cargando tus preferencias…",
  interruptores: {
    buzonCritico: "Coactivas y avisos críticos del buzón",
    credencialInvalida: "Clave SOL inválida",
    planLimite: "Límite del plan",
    resumen: "Resumen diario a las 7:00, de lunes a viernes",
  },
  todos: "Incluir todos los clientes del estudio",
  todosIgnorado:
    "«Todos los clientes» ya no aplica: tu resumen solo incluye los clientes que tienes asignados.",
  fallo: (fecha: string) => `No pudimos enviarte el último correo (${fecha})`,
  guardar: "Guardar",
  guardado: "Guardamos tus preferencias.",
  sinPermisoTodos: "No tienes permiso para incluir todos los clientes del estudio.",
  todosNoDisponible: "Ya no puedes incluir todos los clientes: tienes clientes asignados.",
  errorGuardar: "No se pudieron guardar tus preferencias. Inténtalo de nuevo.",
  errorCarga: "No se pudieron cargar tus preferencias. Inténtalo de nuevo.",
  // Invitación al resumen (`invitacion-resumen.tsx`).
  invitacion: "Recibe un resumen diario por correo",
  activarResumen: "Activar resumen",
  ahoraNo: "Ahora no",
  errorInvitacion: "No se pudo guardar. Inténtalo de nuevo.",
  // `/baja` (D-4, U-18).
  bajaTitulo: "Preferencias de correo",
  bajaPregunta: "¿Quieres dejar de recibir este tipo de correo?",
  bajaBoton: "Darme de baja",
  // Sin punto final: es el texto exacto de D-4 y sale igual con 200, 400, 429 o error de red.
  bajaListo: "Listo. Si el enlace era válido, ya no recibirás este tipo de correo",
  bajaEnlaceCuenta: "Mi cuenta → Correo",
  // `/ir`.
  irAbriendo: "Abriendo la pantalla…",
} as const;

/** Los cinco valores que viajan en el `PUT` (`preferenciasCorreoSchema`, `.strict()`). */
export interface CuerpoPreferenciasCorreo {
  buzonCritico: boolean;
  credencialInvalida: boolean;
  planLimite: boolean;
  resumen: boolean;
  todosClientes: boolean;
}

/** Arma el cuerpo del `PUT`: «todos los clientes» solo viaja si el servidor lo ofrece (no se reenvía una marca ignorada). */
export function cuerpoPreferencias(
  v: CuerpoPreferenciasCorreo,
  todosDisponible: boolean,
  cambios: Partial<CuerpoPreferenciasCorreo> = {},
): CuerpoPreferenciasCorreo {
  const f = { ...v, ...cambios };
  return {
    buzonCritico: f.buzonCritico,
    credencialInvalida: f.credencialInvalida,
    planLimite: f.planLimite,
    resumen: f.resumen,
    todosClientes: todosDisponible ? f.todosClientes : false,
  };
}

/** `GET /cuenta/correo`; `null` si falla o no tiene la forma de `PreferenciasCorreoVista`. */
export async function leerPreferenciasCorreo(): Promise<PreferenciasCorreoVista | null> {
  try {
    const r = await api<unknown>("/cuenta/correo");
    if (!r.ok) return null;
    const vista = preferenciasCorreoVistaSchema.safeParse(r.datos);
    return vista.success ? vista.data : null;
  } catch {
    return null;
  }
}

export type ResultadoGuardarCorreo =
  | { tipo: "ok"; vista: PreferenciasCorreoVista | null }
  | { tipo: "sin_permiso" }
  | { tipo: "todos_no_disponible" }
  | { tipo: "error" };

/** `PUT /cuenta/correo`: traduce la respuesta a un resultado sin códigos crudos. */
export async function guardarPreferenciasCorreo(
  cuerpo: CuerpoPreferenciasCorreo,
): Promise<ResultadoGuardarCorreo> {
  try {
    const r = await api<{ codigo?: string }>("/cuenta/correo", { method: "PUT", body: cuerpo });
    if (r.ok) {
      const vista = preferenciasCorreoVistaSchema.safeParse(r.datos);
      return { tipo: "ok", vista: vista.success ? vista.data : null };
    }
    const codigo = r.datos?.codigo;
    if (r.status === 403 && codigo === "permiso_denegado") return { tipo: "sin_permiso" };
    if (r.status === 409 && codigo === "todos_clientes_no_disponible") return { tipo: "todos_no_disponible" };
    return { tipo: "error" };
  } catch {
    return { tipo: "error" };
  }
}

/** Token de baja: 43 caracteres base64url (32 bytes sin relleno), como `bajaSchema`. */
export const TOKEN_BAJA_FORMA = /^[A-Za-z0-9_-]{43}$/;

/**
 * `POST /correo/baja` con `{token}` (sin sesión, sin CSRF ni estudio). El resultado no se inspecciona: la pantalla dice lo
 * mismo con 200, 400, 429 o un error de red (D-4, U-18).
 */
export async function darDeBajaCorreo(token: string): Promise<void> {
  try {
    await api("/correo/baja", { method: "POST", body: { token }, sinSesion: true });
  } catch {
    // Mismo mensaje en cualquier caso.
  }
}

// `/ir` (D-3): lista cerrada de pantallas a las que enlazan los correos.
interface PantallaIr {
  cliente: boolean;
  destino: (cliente: string) => string;
}

export const PANTALLAS_IR: Readonly<Record<string, PantallaIr>> = {
  buzon_cliente: { cliente: true, destino: (c) => `/clientes/${c}/buzon` },
  credenciales_cliente: { cliente: true, destino: (c) => `/clientes/${c}` },
  compras_cliente: { cliente: true, destino: (c) => `/clientes/${c}/compras` },
  ventas_cliente: { cliente: true, destino: (c) => `/clientes/${c}/ventas` },
  buzon_estudio: { cliente: false, destino: () => "/buzon" },
  uso_plan: { cliente: false, destino: () => "/" },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DestinoIr {
  estudioId: string;
  /** Ruta del sitio (una sola «/» al inicio, sin esquema ni host). */
  ruta: string;
}

/**
 * Valida `?estudio=<uuid>&pantalla=<clave>[&cliente=<uuid>]` ANTES de tocar nada. Otros parámetros se ignoran. `null` si
 * algo no vale; el destino sale solo de la lista cerrada y de un uuid, nunca del texto del enlace.
 */
export function resolverIr(consulta: URLSearchParams): DestinoIr | null {
  const estudio = consulta.get("estudio");
  const pantalla = consulta.get("pantalla");
  const cliente = consulta.get("cliente");
  if (estudio === null || !UUID.test(estudio)) return null;
  if (pantalla === null || !Object.hasOwn(PANTALLAS_IR, pantalla)) return null;
  const def = PANTALLAS_IR[pantalla]!;
  if (cliente !== null && !UUID.test(cliente)) return null;
  if (def.cliente && cliente === null) return null;
  return { estudioId: estudio, ruta: def.destino(cliente ?? "") };
}

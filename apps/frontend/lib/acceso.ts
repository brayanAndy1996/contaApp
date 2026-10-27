import { ROLES, puedeGestionar, type Rol } from "@contapp/shared";
import { api } from "./api";

// Acceso en la UI (spec 005, CA-15). Solo presentación: qué mostrar según `GET /acceso/yo` y qué
// texto enseñar ante cada error. La barrera real es el backend (RNF-007): ocultar es comodidad.

export { ROLES, type Rol };

export const ETIQUETA_ROL: Record<Rol, string> = {
  dueno: "Dueño",
  admin: "Administrador",
  contador: "Contador",
  asistente: "Asistente",
  lectura: "Lectura",
};

/** Cuerpo de `GET /acceso/yo`. */
export interface Yo {
  rol: Rol;
  permisos: string[];
  alcance: "global" | "asignado";
}

export interface Miembro {
  usuarioId: string;
  nombre: string;
  correo: string;
  rol: Rol;
  activo: boolean;
  esYo: boolean;
}

export const MENSAJES = {
  sinPermiso: "No tienes permiso para realizar esta acción.",
  noEncontrado: "No se encontró lo que buscas.",
  errorGeneral: "Ocurrió un error. Inténtalo de nuevo.",
  ultimoDueno: "Debe quedar al menos un Dueño activo en el estudio.",
  yaEsMiembro: "Esa persona ya es miembro del estudio.",
  invitacionExistente: "Ya hay una invitación pendiente para ese correo.",
  cupoUsuarios: "Alcanzaste el límite de usuarios de tu plan.",
  miembroNoAsignable: "Ese usuario no puede ser asignado a este cliente.",
  sinResponsable: "Sin responsable",
} as const;

const POR_CODIGO_409: Record<string, string> = {
  ultimo_dueno: MENSAJES.ultimoDueno,
  ya_es_miembro: MENSAJES.yaEsMiembro,
  invitacion_existente: MENSAJES.invitacionExistente,
  cupo_usuarios: MENSAJES.cupoUsuarios,
  miembro_no_asignable: MENSAJES.miembroNoAsignable,
};

/** Mensaje genérico para un error del backend; nunca muestra el `codigo` ni detalles internos. */
export function mensajeDeError(status: number, datos: unknown): string {
  if (status === 403) return MENSAJES.sinPermiso;
  if (status === 404) return MENSAJES.noEncontrado;
  if (status === 409) {
    const codigo = (datos as { codigo?: string } | null)?.codigo ?? "";
    return POR_CODIGO_409[codigo] ?? MENSAJES.errorGeneral;
  }
  return MENSAJES.errorGeneral;
}

export const tiene = (yo: Yo | null, permiso: string): boolean =>
  yo?.permisos.includes(permiso) ?? false;

/**
 * Presentación de D8 con `puedeGestionar` de shared (solo un Dueño toca o crea un Dueño). El servidor
 * aplica la regla; aquí solo se decide qué opciones y botones mostrar.
 */
export const puedeOtorgar = (actor: Rol, rol: Rol): boolean =>
  puedeGestionar(actor, null, rol);

export const puedeTocar = (actor: Rol, objetivo: Rol): boolean =>
  puedeGestionar(actor, objetivo, null);

/** Carga `GET /acceso/yo`; `null` si falla (el menú y las pantallas lo tratan como "sin permisos"). */
export async function cargarYo(): Promise<{
  yo: Yo | null;
  status: number;
}> {
  const r = await api<Yo>("/acceso/yo");
  return { yo: r.ok ? r.datos : null, status: r.status };
}

export const fechaCorta = (iso: string): string =>
  new Date(iso).toLocaleDateString("es-PE", { timeZone: "UTC" });

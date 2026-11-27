import { useEffect, useState } from "react";
import {
  ROLES,
  permisosEfectivos,
  puedeGestionar,
  type Efectivo,
  type Permiso,
  type Rol,
} from "@contapp/shared";
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

/** Referencia a un rol propio del estudio (spec 030). */
export interface RolPropioRef {
  id: string;
  nombre: string;
}

/** Cuerpo de `GET /acceso/yo`. Con `rol: "propio"` (030) el nombre del rol viene en `rolPropio`. */
export interface Yo {
  rol: Rol | "propio";
  rolPropio?: RolPropioRef | null;
  permisos: string[];
  alcance: "global" | "asignado";
}

export interface Miembro {
  usuarioId: string;
  nombre: string;
  correo: string;
  rol: Rol | "propio";
  rolPropio?: RolPropioRef | null;
  activo: boolean;
  esYo: boolean;
}

/** Texto del rol de un miembro o invitación: la etiqueta del rol de sistema o el nombre del rol propio. */
export function etiquetaDeRol(
  rol: Rol | "propio",
  rolPropio?: (Pick<RolPropioRef, "nombre"> & Partial<RolPropioRef>) | null,
): string {
  return rol === "propio" ? (rolPropio?.nombre ?? "Rol propio") : ETIQUETA_ROL[rol];
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
  clienteArchivado:
    "Hay clientes archivados en la selección. Reactívalos o quítalos para asignar.",
  sinResponsable: "Sin responsable",
  escalada: "No puedes otorgar permisos ni un alcance que tú no tienes.",
  rolPropio: "No puedes modificar el rol que tienes asignado.",
} as const;

const POR_CODIGO_409: Record<string, string> = {
  ultimo_dueno: MENSAJES.ultimoDueno,
  ya_es_miembro: MENSAJES.yaEsMiembro,
  invitacion_existente: MENSAJES.invitacionExistente,
  cupo_usuarios: MENSAJES.cupoUsuarios,
  miembro_no_asignable: MENSAJES.miembroNoAsignable,
  cliente_archivado: MENSAJES.clienteArchivado,
};

/** Mensaje genérico para un error del backend; nunca muestra el `codigo` ni detalles internos. */
export function mensajeDeError(status: number, datos: unknown): string {
  if (status === 403) {
    const codigo = (datos as { codigo?: string } | null)?.codigo;
    if (codigo === "escalada") return MENSAJES.escalada;
    if (codigo === "rol_propio") return MENSAJES.rolPropio;
    return MENSAJES.sinPermiso;
  }
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

/**
 * Presentación de U2 con el rol propio del actor: cabe lo que está contenido en sus permisos y su alcance. Solo se
 * usa cuando el actor tiene un rol propio y no se pudo cargar `GET /roles/asignables`; el servidor decide.
 */
export function puedeOtorgarComoPropio(yo: Yo, rol: Rol): boolean {
  const actor: Efectivo = {
    rolSistema: null,
    permisos: new Set(yo.permisos as Permiso[]),
    alcance: yo.alcance,
  };
  return puedeGestionar(actor, null, permisosEfectivos(rol));
}

/** Carga `GET /acceso/yo`; `null` si falla (el menú y las pantallas lo tratan como "sin permisos"). */
export async function cargarYo(): Promise<{
  yo: Yo | null;
  status: number;
}> {
  const r = await api<Yo>("/acceso/yo");
  return { yo: r.ok ? r.datos : null, status: r.status };
}

/**
 * ¿Tiene el usuario `permiso` en el estudio activo? Solo oculta (RNF-007): el backend valida.
 * Devuelve `undefined` mientras carga `GET /acceso/yo`, para no mostrar nada a medias.
 */
export function usePuede(permiso: string): boolean | undefined {
  const [yo, setYo] = useState<Yo | null | undefined>(undefined);

  useEffect(() => {
    let vigente = true;
    cargarYo()
      .then(({ yo: actual }) => {
        if (vigente) setYo(actual);
      })
      .catch(() => {
        if (vigente) setYo(null);
      });
    return () => {
      vigente = false;
    };
  }, []);

  return yo === undefined ? undefined : tiene(yo, permiso);
}

export { fechaCorta } from "./fechas";

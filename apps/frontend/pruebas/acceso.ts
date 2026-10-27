import { screen } from "@testing-library/react";
import { vi } from "vitest";
import { sesionDe, type Manejador } from "./soporte";

// Soporte de las pruebas de pantallas de acceso (spec 005, T6): mensajes visibles, etiquetas de rol,
// respuestas de `GET /acceso/yo` y ayudas para leer filas. Son el contrato de T12: las pantallas
// deben mostrar estos textos exactos. Solo datos de prueba (canarios); sin lógica de producción.

export type RolPrueba =
  "dueno" | "admin" | "contador" | "asistente" | "lectura";

/** Etiqueta visible de cada rol de sistema. */
export const ETIQUETA_ROL: Record<RolPrueba, string> = {
  dueno: "Dueño",
  admin: "Administrador",
  contador: "Contador",
  asistente: "Asistente",
  lectura: "Lectura",
};

export const MENSAJES_ACCESO = {
  // 403 de cualquier ruta: genérico, no revela qué faltó.
  sinPermiso: "No tienes permiso para realizar esta acción.",
  // 404 de cualquier ruta: igual para inexistente, ajeno y no asignado (CA-5).
  noEncontrado: "No se encontró lo que buscas.",
  errorGeneral: "Ocurrió un error. Inténtalo de nuevo.",
  ultimoDueno: "Debe quedar al menos un Dueño activo en el estudio.",
  yaEsMiembro: "Esa persona ya es miembro del estudio.",
  invitacionExistente: "Ya hay una invitación pendiente para ese correo.",
  cupoUsuarios: "Alcanzaste el límite de usuarios de tu plan.",
  invitacionEnviada: "Invitación enviada.",
  miembroNoAsignable: "Ese usuario no puede ser asignado a este cliente.",
  sinResponsable: "Sin responsable",
  // /invitacion
  invitacionInvalida:
    "La invitación no es válida o venció. Pide una nueva al estudio.",
  cuentaCreada: "Tu cuenta fue creada. Ya puedes iniciar sesión.",
  asignados: (n: number) => `Clientes asignados: ${n}`,
  unidoA: (estudio: string) => `Te uniste a ${estudio}.`,
} as const;

/**
 * Permisos de prueba por rol: SUBCONJUNTO de la matriz D2/D17 con lo que usan las pantallas
 * (no los 22 del catálogo). Dueño y Administrador gestionan usuarios y asignan clientes.
 */
const PERMISOS_PRUEBA: Record<RolPrueba, string[]> = {
  dueno: [
    "clientes.ver",
    "clientes.asignar",
    "usuarios.ver",
    "usuarios.gestionar",
  ],
  admin: [
    "clientes.ver",
    "clientes.asignar",
    "usuarios.ver",
    "usuarios.gestionar",
  ],
  contador: ["clientes.ver", "credenciales.editar"],
  asistente: ["clientes.ver", "sire.descargar", "sire.clasificar"],
  lectura: ["clientes.ver"],
};

/** Cuerpo de `GET /acceso/yo` (plan 005: `{rol, permisos, alcance}`). */
export function yoDe(rol: RolPrueba, permisos?: string[]) {
  return {
    rol,
    permisos: permisos ?? PERMISOS_PRUEBA[rol],
    alcance: rol === "dueno" || rol === "admin" ? "global" : "asignado",
  };
}

/** Ruta simulada de la sesión con un estudio activo (para `api()` con cabeceras de sesión). */
export function rutaSesion(csrf = "csrf-acceso-1"): Record<string, Manejador> {
  return {
    "GET /api/auth/sesion": {
      status: 200,
      cuerpo: sesionDe({ id: "e-a", nombre: "Estudio Alfa" }, csrf),
    },
  };
}

/** Fila (`role=row`) cuyo texto contiene `texto`; lanza si no existe (úsese con `vi.waitFor`). */
export function fila(texto: string): HTMLElement {
  const encontrada = screen
    .queryAllByRole("row")
    .find((f) => f.textContent?.includes(texto));
  if (!encontrada) throw new Error(`no hay fila con "${texto}"`);
  return encontrada;
}

/** Espera a que aparezca la fila con `texto`. */
export async function esperarFila(texto: string): Promise<HTMLElement> {
  return vi.waitFor(() => fila(texto));
}

/** Texto de cada celda de una fila (td, th, o roles cell/gridcell/rowheader). */
export function celdas(f: HTMLElement): string[] {
  return [
    ...f.querySelectorAll(
      "td, th, [role=cell], [role=gridcell], [role=rowheader]",
    ),
  ].map((c) => c.textContent ?? "");
}

/** Deja correr las promesas pendientes (para afirmar que algo NO apareció). */
export async function asentar(ms = 30): Promise<void> {
  await new Promise((resolver) => setTimeout(resolver, ms));
}

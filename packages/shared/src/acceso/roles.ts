import { PERMISOS, type Permiso } from "./permisos.js";
import type { Efectivo } from "./efectivos.js";

/** Roles de sistema, de mayor a menor privilegio (D2). */
export const ROLES = [
  "dueno",
  "admin",
  "contador",
  "asistente",
  "lectura",
] as const;

export type Rol = (typeof ROLES)[number];

const LECTURA: readonly Permiso[] = [
  "clientes.ver",
  "buzon.ver",
  "reglas.ver",
  "prorrata.ver",
];

const ASISTENTE: readonly Permiso[] = [
  ...LECTURA,
  "sire.descargar",
  "sire.clasificar",
  "buzon.marcar_leido",
  "buzon.atender",
];

const CONTADOR: readonly Permiso[] = [
  ...ASISTENTE,
  "credenciales.editar",
  "sire.aprobar_generar",
  "ajustes.crear",
  "ajustes.generar",
  "reglas.gestionar",
  "prorrata.gestionar",
];

const ADMIN: readonly Permiso[] = PERMISOS.filter(
  (p) => p !== "plan.gestionar",
);

/** Matriz rol × permiso (D2/D17). */
export const PERMISOS_POR_ROL: Record<Rol, ReadonlySet<Permiso>> = {
  dueno: new Set(PERMISOS),
  admin: new Set(ADMIN),
  contador: new Set(CONTADOR),
  asistente: new Set(ASISTENTE),
  lectura: new Set(LECTURA),
};

export function tienePermiso(rol: Rol, permiso: Permiso): boolean {
  return PERMISOS_POR_ROL[rol]?.has(permiso) ?? false;
}

/** D16: Dueño y Administrador ven todos los clientes; el resto, solo los asignados. */
export function alcanceDe(rol: Rol): "global" | "asignado" {
  return rol === "dueno" || rol === "admin" ? "global" : "asignado";
}

/** Permisos y alcance de un rol de sistema o de un `Efectivo` ya resuelto (sin importar `efectivos.ts` en tiempo de ejecución). */
function comoConjunto(x: Rol | Efectivo): {
  permisos: ReadonlySet<Permiso>;
  alcance: "global" | "asignado";
} {
  return typeof x === "string"
    ? { permisos: PERMISOS_POR_ROL[x], alcance: alcanceDe(x) }
    : x;
}

/**
 * D18: puede ser responsable de un cliente quien clasifica SIRE. Acepta la clave de un rol de sistema (llamadas de 005)
 * o un `Efectivo` (030: también roles propios).
 */
export function puedeSerResponsable(x: Rol | Efectivo): boolean {
  return comoConjunto(x).permisos.has("sire.clasificar");
}

/** ¿Los permisos y el alcance de `objetivo` están contenidos en los del actor? (global ⊇ asignado; null = nada que tocar). */
function contenido(
  actor: Rol | Efectivo,
  objetivo: Rol | Efectivo | null,
): boolean {
  if (objetivo === null) return true;
  const a = comoConjunto(actor);
  const o = comoConjunto(objetivo);
  if (o.alcance === "global" && a.alcance !== "global") return false;
  for (const p of o.permisos) if (!a.permisos.has(p)) return false;
  return true;
}

/**
 * D8 + U2/U4 (030): el actor gestiona (invita, cambia de rol, desactiva) si los permisos y el alcance del rol actual del
 * objetivo y del rol nuevo están contenidos en los suyos. Solo un Dueño toca o crea un Dueño (`plan.gestionar`). Acepta
 * claves de rol de sistema (005) o `Efectivo` (030), todos de la misma clase.
 */
export function puedeGestionar(
  actor: Rol,
  objetivoActual: Rol | null,
  rolNuevo: Rol | null,
): boolean;
export function puedeGestionar(
  actor: Efectivo,
  objetivoActual: Efectivo | null,
  rolNuevo: Efectivo | null,
): boolean;
export function puedeGestionar(
  actor: Rol | Efectivo,
  objetivoActual: Rol | Efectivo | null,
  rolNuevo: Rol | Efectivo | null,
): boolean {
  return contenido(actor, objetivoActual) && contenido(actor, rolNuevo);
}

/**
 * U2/U4 (030): crear (`antes` null), editar o eliminar (`despues` null) un rol propio. Nadie toca el rol que tiene asignado;
 * si no, el rol antes y después debe estar contenido (permisos y alcance) en el actor. `roles.gestionar` lo decide el guard.
 */
export function puedeGestionarRol(
  actor: Efectivo,
  antes: Efectivo | null,
  despues: Efectivo | null,
  esPropioDelActor: boolean,
): boolean {
  return !esPropioDelActor && contenido(actor, antes) && contenido(actor, despues);
}

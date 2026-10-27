import { PERMISOS, type Permiso } from "./permisos.js";

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
];

const CONTADOR: readonly Permiso[] = [
  ...ASISTENTE,
  "credenciales.editar",
  "sire.aprobar_generar",
  "ajustes.crear",
  "ajustes.generar",
  "reglas.gestionar",
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

/** D18: puede ser responsable de un cliente quien clasifica SIRE. */
export function puedeSerResponsable(rol: Rol): boolean {
  return tienePermiso(rol, "sire.clasificar");
}

function incluido(rol: Rol | null, actor: Rol): boolean {
  if (rol === null) return true;
  const propios = PERMISOS_POR_ROL[actor];
  for (const p of PERMISOS_POR_ROL[rol]) if (!propios.has(p)) return false;
  return true;
}

/**
 * D8: el actor gestiona (invita, cambia de rol, desactiva) si los permisos del rol actual del
 * objetivo y del rol nuevo están contenidos en los suyos. Solo un Dueño toca o crea un Dueño.
 */
export function puedeGestionar(
  actor: Rol,
  objetivoActual: Rol | null,
  rolNuevo: Rol | null,
): boolean {
  return incluido(objetivoActual, actor) && incluido(rolNuevo, actor);
}

import type { Permiso } from "./permisos.js";
import { alcanceDe, PERMISOS_POR_ROL, type Rol } from "./roles.js";

// Spec 030 (plan: Contratos: Shared; spec D3, U7). Resolvedor de permisos efectivos de UNA membresía: rol de sistema o rol
// propio del estudio. Sin IO; la misma resolución vive en SQL (`acceso.permisos_membresia`) y ambas se prueban con
// `CASOS_EFECTIVOS`.

export type AlcanceRol = "global" | "asignado";

/** Lo guardado de un rol propio del estudio. */
export interface DefinicionRolPropio {
  permisos: readonly Permiso[];
  alcance: AlcanceRol;
}

/**
 * Permisos y alcance efectivos. `rolSistema` es la clave del rol de sistema o `null` si es un rol propio
 * (U7: un rol propio nunca cuenta como Dueño).
 */
export interface Efectivo {
  rolSistema: Rol | null;
  permisos: ReadonlySet<Permiso>;
  alcance: AlcanceRol;
}

/**
 * Resuelve el `Efectivo` de un rol de sistema (su fila de la matriz y `alcanceDe`; `propio` se ignora) o de un rol propio
 * (copia de sus permisos y su alcance). `'propio'` sin su definición lanza: nunca se resuelve a vacío en silencio.
 */
export function permisosEfectivos(
  rol: Rol | "propio",
  propio?: DefinicionRolPropio,
): Efectivo {
  if (rol !== "propio") {
    return {
      rolSistema: rol,
      permisos: new Set(PERMISOS_POR_ROL[rol]),
      alcance: alcanceDe(rol),
    };
  }
  if (propio === undefined) {
    throw new Error("rol propio sin definición");
  }
  return {
    rolSistema: null,
    permisos: new Set(propio.permisos),
    alcance: propio.alcance,
  };
}

/** D16 ampliada: el alcance del rol (sistema por `alcanceDe`, propio el guardado). */
export function alcanceEfectivo(e: Efectivo): AlcanceRol {
  return e.alcance;
}

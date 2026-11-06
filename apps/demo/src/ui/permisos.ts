import { PERMISOS_ROL } from "../datos/semilla";

export function puede(rol: string | undefined, permiso: string): boolean {
  return !!rol && (PERMISOS_ROL as Record<string, string[]>)[rol]?.includes(permiso) === true;
}

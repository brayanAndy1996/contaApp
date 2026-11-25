import { factorExigido, PERMISOS_POR_ROL, type Permiso, type Rol } from "@contapp/shared";

// Spec 029 (U1–U2, D2). Exigencia del segundo factor para un rol de estudio, con la regla común de shared (`factorExigido`, la misma tabla de
// casos que `auth.totp_desactivar`). Puro: sin IO.

/** Permisos del rol (matriz de 005) o `undefined` si el rol no está en la matriz. */
export function permisosDeRol(rol: string): ReadonlySet<Permiso> | undefined {
  return (PERMISOS_POR_ROL as Partial<Record<string, ReadonlySet<Permiso>>>)[rol];
}

/** ¿El rol de una membresía exige TOTP verificado? Un rol fuera de la matriz lo exige (falla cerrado). */
export function rolExigeFactor(rol: string): boolean {
  const permisos = permisosDeRol(rol);
  if (permisos === undefined) return true;
  return factorExigido({ plataforma: false, rolSistema: rol as Rol, permisos: [...permisos] });
}

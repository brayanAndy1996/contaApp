import { factorExigido, PERMISOS_POR_ROL, type Efectivo, type Permiso, type Rol } from "@contapp/shared";

// Spec 029 (U1–U2, D2). Exigencia del segundo factor para un rol de estudio, con la regla común de shared (`factorExigido`, la misma tabla de
// casos que `auth.totp_desactivar`). Puro: sin IO.
// Spec 030 (CA-7, U8): con permisos EFECTIVOS. Un rol de sistema decide por su clave; un rol propio, por sus permisos sensibles.

/** Permisos del rol (matriz de 005) o `undefined` si el rol no está en la matriz. */
export function permisosDeRol(rol: string): ReadonlySet<Permiso> | undefined {
  return (PERMISOS_POR_ROL as Partial<Record<string, ReadonlySet<Permiso>>>)[rol];
}

/** ¿El rol de sistema de una membresía exige TOTP verificado? Un rol fuera de la matriz (también `propio` sin definición) lo exige. */
export function rolExigeFactor(rol: string): boolean {
  const permisos = permisosDeRol(rol);
  if (permisos === undefined) return true;
  return factorExigido({ plataforma: false, rolSistema: rol as Rol, permisos: [...permisos] });
}

/** ¿Los permisos efectivos de una membresía exigen TOTP verificado? `null` (rol sin resolver) lo exige: falla cerrado. */
export function efectivoExigeFactor(e: Efectivo | null): boolean {
  if (e === null) return true;
  return factorExigido({ plataforma: false, rolSistema: e.rolSistema, permisos: [...e.permisos] });
}

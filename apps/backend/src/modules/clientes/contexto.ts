import type { Alcance } from "@contapp/db";
import type { SesionResuelta } from "../auth/auth.service.js";
import { AccesoError } from "../acceso/errores.js";
import type { Acceso } from "../acceso/guards/decoradores.js";

/** UUID canónico (8-4-4-4-12 hex): cualquier otra cosa en la ruta es 404 sin tocar la BD. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function esUuid(valor: string): boolean {
  return UUID.test(valor);
}

/** Contexto de `withTenant` de la sesión; `PermisoGuard` ya garantizó estudio activo. */
export function contextoDe(sesion: SesionResuelta): { tenantId: string; userId: string } {
  if (sesion.tenantActivo === null) throw new AccesoError("estudio_requerido");
  return { tenantId: sesion.tenantActivo, userId: sesion.usuarioId };
}

/** Alcance del actor para `filtroAlcance` (D5); lo que no sea global se trata como asignado (falla cerrado). */
export function alcanceDe(acceso: Acceso | undefined): Alcance {
  if (acceso === undefined) throw new AccesoError("permiso_denegado");
  return acceso.alcance === "global"
    ? { tipo: "global" }
    : { tipo: "asignado", usuarioId: acceso.usuarioId };
}

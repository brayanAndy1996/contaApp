import { SetMetadata } from "@nestjs/common";
import type { Permiso as TipoPermiso, Rol } from "@contapp/shared";

// Declaraciones de acceso de 005 (D4, CA-11). Toda ruta declara exactamente una familia: `@Permiso(p)`,
// `@SoloEstudio()` o las marcas de 004 (`@Publico`, `@SinEstudio`, `@SesionOpcional`). Sin ninguna,
// `PermisoGuard` responde 403 `permiso_denegado`.
export const META_PERMISO = "acceso:permiso";
export const META_SOLO_ESTUDIO = "acceso:solo-estudio";
export const META_SOLO_PLATAFORMA = "acceso:solo-plataforma";

/** Exige sesión, estudio activo y el permiso `p` en el rol de la membresía activa (D3). */
export const Permiso = (p: TipoPermiso) => SetMetadata(META_PERMISO, p);
/** Exige sesión y estudio activo, sin permiso (p. ej. `GET /estudio/actual`, `GET /acceso/yo`). */
export const SoloEstudio = () => SetMetadata(META_SOLO_ESTUDIO, true);
/**
 * STUB de T2 (006, pruebas primero): T9 lo implementa. Declaración de plataforma (D5): solo junto a
 * `@SinEstudio`, nunca con `@Permiso`/`@SoloEstudio`.
 */
export const SoloPlataforma = (): MethodDecorator & ClassDecorator => {
  throw new Error("no implementado (006 T9)");
};

/** Lo que `PermisoGuard` deja en la petición (no enumerable: no se serializa). */
export interface Acceso {
  usuarioId: string;
  rol: Rol;
  permisos: ReadonlySet<TipoPermiso>;
  alcance: "global" | "asignado";
}

export interface PeticionAcceso {
  acceso?: Acceso;
  params?: Record<string, string | undefined>;
}

/** Fija `req.acceso` sin que aparezca en `Object.keys` ni en `JSON.stringify`. */
export function fijarAcceso(req: PeticionAcceso, acceso: Acceso): void {
  Object.defineProperty(req, "acceso", {
    value: Object.freeze(acceso),
    enumerable: false,
    configurable: true,
    writable: false,
  });
}

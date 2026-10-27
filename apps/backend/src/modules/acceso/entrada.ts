import { AccesoRepoError } from "@contapp/db";
import { AccesoError } from "./errores.js";

/** UUID canónico (8-4-4-4-12 hex). Cualquier otra cosa en la ruta es 404, sin tocar la BD (plan, shared). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ID de la ruta en minúsculas (forma canónica de la BD y de la sesión) o 404 `no_encontrado` (mismo cuerpo que
 * inexistente o ajeno: D13). Normalizar evita que `ID-EN-MAYÚSCULAS` burle "no sobre uno mismo" (H-005-1a-1).
 */
export function idDeRuta(valor: string | undefined): string {
  if (valor === undefined || !UUID.test(valor))
    throw new AccesoError("no_encontrado");
  return valor.toLowerCase();
}

interface Esquema<T> {
  safeParse(valor: unknown): { success: boolean; data?: T };
}

/** zod -> 400 `solicitud_invalida` sin eco de la entrada; las claves desconocidas se descartan (CA-4). */
export function parsearCuerpo<T>(esquema: Esquema<T>, cuerpo: unknown): T {
  const r = esquema.safeParse(cuerpo);
  if (!r.success) throw new AccesoError("solicitud_invalida");
  return r.data as T;
}

/** SQLSTATE del trigger `membresia_ultimo_dueno` (0012, D10) -> 409 `ultimo_dueno`; el resto sigue igual. */
export function traducirUltimoDueno(e: unknown): unknown {
  return e instanceof AccesoRepoError && e.codigo === "P0001"
    ? new AccesoError("ultimo_dueno")
    : e;
}

/** Otra invitación pendiente del mismo correo (índice único parcial, SQLSTATE 23505) -> 409. */
export function traducirInvitacionExistente(e: unknown): unknown {
  return e instanceof AccesoRepoError && e.codigo === "23505"
    ? new AccesoError("invitacion_existente")
    : e;
}

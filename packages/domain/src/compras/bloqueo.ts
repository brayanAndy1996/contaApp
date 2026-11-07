// Bloqueo de escrituras por estado del periodo (spec 014, D-9, DU-4). Decide solo por el estado: que el
// usuario tenga el permiso base de la acción (sire.clasificar, sire.descargar) lo comprueba el guard.
export type EstadoPeriodo = "abierto" | "revisado" | "generado";

export type ResultadoEscritura =
  | { readonly ok: true }
  | { readonly ok: false; readonly codigo: "periodo_revisado" | "periodo_generado" };

export const PERMISO_APROBAR_GENERAR = "sire.aprobar_generar";

/** Un estado fuera de los tres conocidos no deja pasar en silencio. */
export class EstadoPeriodoInvalidoError extends Error {
  constructor() {
    super("Estado de periodo desconocido.");
    this.name = "EstadoPeriodoInvalidoError";
  }
}

/**
 * abierto: sí. revisado: solo con sire.aprobar_generar (403 periodo_revisado si no). generado: nadie,
 * tampoco con sire.aprobar_generar (409 periodo_generado): hay que reabrir antes.
 */
export function puedeEscribir(estado: EstadoPeriodo, permisos: readonly string[]): ResultadoEscritura {
  if (estado === "abierto") return { ok: true };
  if (estado === "revisado") {
    return permisos.includes(PERMISO_APROBAR_GENERAR) ? { ok: true } : { ok: false, codigo: "periodo_revisado" };
  }
  if (estado === "generado") return { ok: false, codigo: "periodo_generado" };
  throw new EstadoPeriodoInvalidoError();
}

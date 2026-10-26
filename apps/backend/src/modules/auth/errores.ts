/** Motivo por el que una contraseña nueva no cumple la política (P5). */
export type MotivoContrasena = "longitud" | "comun";

/**
 * La contraseña no cumple la política. Solo lleva el motivo: nunca la contraseña, ni parcial,
 * en `message`, `stack` ni `cause` (CA-10).
 */
export class ContrasenaInvalidaError extends Error {
  readonly motivo: MotivoContrasena;

  constructor(motivo: MotivoContrasena) {
    super("contrasena_invalida");
    this.name = "ContrasenaInvalidaError";
    this.motivo = motivo;
  }
}

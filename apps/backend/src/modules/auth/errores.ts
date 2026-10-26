import { HttpException, HttpStatus } from "@nestjs/common";

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

/** Códigos de error del módulo `auth` (plan: Contratos HTTP). */
export type CodigoAuth =
  | "credenciales_invalidas"
  | "demasiados_intentos"
  | "sesion_invalida"
  | "solicitud_invalida"
  | "origen_invalido"
  | "csrf_invalido"
  | "estudio_requerido"
  | "estudio_desfasado"
  | "estudio_no_disponible"
  | "token_invalido";

const ESTADO: Record<CodigoAuth, number> = {
  credenciales_invalidas: HttpStatus.UNAUTHORIZED,
  demasiados_intentos: HttpStatus.TOO_MANY_REQUESTS,
  sesion_invalida: HttpStatus.UNAUTHORIZED,
  solicitud_invalida: HttpStatus.BAD_REQUEST,
  origen_invalido: HttpStatus.FORBIDDEN,
  csrf_invalido: HttpStatus.FORBIDDEN,
  estudio_requerido: HttpStatus.FORBIDDEN,
  estudio_desfasado: HttpStatus.CONFLICT,
  estudio_no_disponible: HttpStatus.FORBIDDEN,
  token_invalido: HttpStatus.BAD_REQUEST,
};

/**
 * Error de negocio de `auth`: cuerpo `{ codigo }` (sin eco de la entrada) y el estado HTTP del plan.
 * El filtro global lo responde tal cual.
 */
export class AuthError extends HttpException {
  readonly codigo: CodigoAuth;

  constructor(codigo: CodigoAuth) {
    super({ codigo }, ESTADO[codigo]);
    this.name = "AuthError";
    this.codigo = codigo;
  }
}

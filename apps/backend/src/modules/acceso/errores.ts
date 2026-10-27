import { HttpException, HttpStatus } from "@nestjs/common";

/** Códigos de error del módulo `acceso` (plan 005: Contratos HTTP). */
export type CodigoAcceso =
  | "permiso_denegado"
  | "estudio_requerido"
  | "no_encontrado"
  | "solicitud_invalida"
  | "invitacion_invalida"
  | "anterior_requerido"
  | "ultimo_dueno"
  | "ya_es_miembro"
  | "invitacion_existente"
  | "cupo_usuarios"
  | "requiere_sesion"
  | "miembro_no_asignable";

const ESTADO: Record<CodigoAcceso, number> = {
  permiso_denegado: HttpStatus.FORBIDDEN,
  estudio_requerido: HttpStatus.FORBIDDEN,
  no_encontrado: HttpStatus.NOT_FOUND,
  solicitud_invalida: HttpStatus.BAD_REQUEST,
  invitacion_invalida: HttpStatus.BAD_REQUEST,
  anterior_requerido: HttpStatus.BAD_REQUEST,
  ultimo_dueno: HttpStatus.CONFLICT,
  ya_es_miembro: HttpStatus.CONFLICT,
  invitacion_existente: HttpStatus.CONFLICT,
  cupo_usuarios: HttpStatus.CONFLICT,
  requiere_sesion: HttpStatus.CONFLICT,
  miembro_no_asignable: HttpStatus.CONFLICT,
};

/**
 * Error de `acceso`: cuerpo `{ codigo }` sin eco de la entrada (ni IDs ni motivo) y el estado del plan.
 * El filtro global de 004 lo responde tal cual.
 */
export class AccesoError extends HttpException {
  readonly codigo: CodigoAcceso;

  constructor(codigo: CodigoAcceso) {
    super({ codigo }, ESTADO[codigo]);
    this.name = "AccesoError";
    this.codigo = codigo;
  }
}

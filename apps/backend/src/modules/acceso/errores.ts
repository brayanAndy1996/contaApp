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
  | "miembro_no_asignable"
  | "plan_inactivo"
  | "codigo_existente"
  | "cliente_archivado"
  | "ruc_duplicado"
  | "credencial_no_configurada"
  // Spec 030: roles propios.
  | "escalada"
  | "rol_propio"
  | "rol_en_uso"
  | "nombre_duplicado"
  | "limite_roles"
  | "permiso_invalido"
  | "combinacion_invalida";

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
  plan_inactivo: HttpStatus.CONFLICT,
  codigo_existente: HttpStatus.CONFLICT,
  cliente_archivado: HttpStatus.CONFLICT,
  ruc_duplicado: HttpStatus.CONFLICT,
  credencial_no_configurada: HttpStatus.CONFLICT,
  escalada: HttpStatus.FORBIDDEN,
  rol_propio: HttpStatus.FORBIDDEN,
  rol_en_uso: HttpStatus.CONFLICT,
  nombre_duplicado: HttpStatus.CONFLICT,
  limite_roles: HttpStatus.CONFLICT,
  permiso_invalido: HttpStatus.UNPROCESSABLE_ENTITY,
  combinacion_invalida: HttpStatus.UNPROCESSABLE_ENTITY,
};

/** Datos propios del sistema que acompañan al código (conteos de `rol_en_uso`, permiso faltante); nunca eco de la entrada. */
export type DatosError = Readonly<Record<string, number | string>>;

/**
 * Error de `acceso`: cuerpo `{ codigo }` (más `datos`, solo conteos o un permiso del catálogo) sin eco de la entrada (ni IDs ni
 * motivo) y el estado del plan. El filtro global de 004 lo responde tal cual.
 */
export class AccesoError extends HttpException {
  readonly codigo: CodigoAcceso;
  /** Lo que el filtro global responde tal cual. */
  readonly cuerpo: { codigo: CodigoAcceso } & DatosError;

  constructor(codigo: CodigoAcceso, datos?: DatosError) {
    const cuerpo = { codigo, ...datos };
    super(cuerpo, ESTADO[codigo]);
    this.cuerpo = cuerpo;
    this.name = "AccesoError";
    this.codigo = codigo;
  }
}

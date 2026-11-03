import { HttpException, HttpStatus } from "@nestjs/common";

/** Códigos propios del registro público (plan 006: Contratos HTTP de `/registro`). */
export type CodigoRegistro = "registro_invalido" | "registro_no_disponible";

const ESTADO: Record<CodigoRegistro, number> = {
  registro_invalido: HttpStatus.BAD_REQUEST,
  registro_no_disponible: HttpStatus.SERVICE_UNAVAILABLE,
};

/**
 * Error del registro: cuerpo `{ codigo }` sin eco de la entrada. `registro_invalido` es la misma respuesta
 * para enlace alterado, vencido, reusado, invalidado o ajeno (CA-4: sin oráculo).
 */
export class RegistroError extends HttpException {
  readonly codigo: CodigoRegistro;

  constructor(codigo: CodigoRegistro) {
    super({ codigo }, ESTADO[codigo]);
    this.name = "RegistroError";
    this.codigo = codigo;
  }
}

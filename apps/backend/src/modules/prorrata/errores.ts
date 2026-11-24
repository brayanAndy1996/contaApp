import { HttpException, HttpStatus } from "@nestjs/common";
import type { CodigoErrorProrrata } from "@contapp/shared";

const ESTADO: Record<CodigoErrorProrrata, number> = {
  // D-5: la versión que vio quien guarda ya no es la vigente del mes (compare-and-set).
  mes_cambiado: HttpStatus.CONFLICT,
  // R-5: el mes ya tiene una declaración (PDT 621); el manual no se puede guardar.
  mes_declarado: HttpStatus.CONFLICT,
  // R-8: el PDT vigente del periodo ya trae la prorrata usada; no se ingresa otra.
  prorrata_declarada: HttpStatus.CONFLICT,
  // R-1: M posterior al mes en curso (hora de Lima).
  periodo_futuro: HttpStatus.BAD_REQUEST,
};

/** Error de la prorrata (spec 026, D-5, D-7): el cuerpo es solo `{ codigo }`, sin eco de la entrada, montos ni RUC. */
export class ProrrataError extends HttpException {
  readonly codigo: CodigoErrorProrrata;

  constructor(codigo: CodigoErrorProrrata) {
    super({ codigo }, ESTADO[codigo]);
    this.name = "ProrrataError";
    this.codigo = codigo;
  }
}

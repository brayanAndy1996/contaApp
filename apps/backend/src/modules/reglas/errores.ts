import { HttpException, HttpStatus } from "@nestjs/common";
import type { CodigoErrorRegla } from "@contapp/shared";

const ESTADO: Record<CodigoErrorRegla, number> = {
  // D-5: la versión base ya no es la de la regla (o «Recordar» con `versionBase = null` y ya hay una viva).
  regla_cambiada: HttpStatus.CONFLICT,
  // P-2: «Recordar» con compras de más de un proveedor.
  proveedores_distintos: HttpStatus.UNPROCESSABLE_ENTITY,
};

/** Error de reglas aprendidas: el cuerpo es solo `{ codigo }`, sin eco de la entrada ni datos del proveedor (D-10). */
export class ReglasError extends HttpException {
  readonly codigo: CodigoErrorRegla;

  constructor(codigo: CodigoErrorRegla) {
    super({ codigo }, ESTADO[codigo]);
    this.name = "ReglasError";
    this.codigo = codigo;
  }
}

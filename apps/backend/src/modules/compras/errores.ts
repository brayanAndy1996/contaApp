import { HttpException, HttpStatus } from "@nestjs/common";

/** Códigos de error propios de las rutas de compras (spec 014). Los de acceso (404, 400, 409 archivado) son de `AccesoError`. */
export type CodigoCompras = "periodo_revisado" | "periodo_generado" | "resumen_fuera_de_rango";

const ESTADO: Record<CodigoCompras, number> = {
  // D-9: el periodo está revisado y quien escribe no tiene `sire.aprobar_generar`.
  periodo_revisado: HttpStatus.FORBIDDEN,
  // D-9: el periodo ya generó su archivo; nadie escribe hasta reabrirlo.
  periodo_generado: HttpStatus.CONFLICT,
  // D-8: una suma excede NUMERIC(14,2) (`MontoFueraDeRangoError` del dominio): error controlado, nunca un 500.
  resumen_fuera_de_rango: HttpStatus.UNPROCESSABLE_ENTITY,
};

/**
 * Error de compras: cuerpo `{ codigo }` sin eco de la entrada (ni filas ni montos ni ids) y el estado del contrato. El filtro
 * global lo responde tal cual.
 */
export class ComprasError extends HttpException {
  readonly codigo: CodigoCompras;

  constructor(codigo: CodigoCompras) {
    super({ codigo }, ESTADO[codigo]);
    this.name = "ComprasError";
    this.codigo = codigo;
  }
}

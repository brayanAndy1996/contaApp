import { HttpException, HttpStatus } from "@nestjs/common";

/** Códigos de error propios de las rutas de ventas (spec 013). Los de acceso (404, 409 archivado, 400) son de `AccesoError`. */
export type CodigoVentas =
  | "duplicado"
  | "venta_descuadrada"
  | "venta_no_quitable"
  | "salto_fuera_de_faltante"
  | "resumen_fuera_de_rango";

const ESTADO: Record<CodigoVentas, number> = {
  // D9: la clave (tipo, serie, número) ya está en el periodo, también contra una fila del SIRE.
  duplicado: HttpStatus.CONFLICT,
  // D9: el total no cuadra con Σ de las siete columnas (tolerancia 0.00).
  venta_descuadrada: HttpStatus.BAD_REQUEST,
  // D4: solo se quita lo agregado a mano; una fila del SIRE es inmutable.
  venta_no_quitable: HttpStatus.CONFLICT,
  // D8: el rango a justificar no está dentro de un faltante actual.
  salto_fuera_de_faltante: HttpStatus.BAD_REQUEST,
  // D11: una suma excede NUMERIC(14,2) (`MontoFueraDeRangoError` del dominio): error controlado, nunca un 500.
  resumen_fuera_de_rango: HttpStatus.UNPROCESSABLE_ENTITY,
};

/**
 * Error de ventas: cuerpo `{ codigo }` sin eco de la entrada (ni filas ni montos ni ids) y el estado del contrato.
 * El filtro global lo responde tal cual.
 */
export class VentasError extends HttpException {
  readonly codigo: CodigoVentas;

  constructor(codigo: CodigoVentas) {
    super({ codigo }, ESTADO[codigo]);
    this.name = "VentasError";
    this.codigo = codigo;
  }
}

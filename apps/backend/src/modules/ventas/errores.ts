import { HttpException, HttpStatus } from "@nestjs/common";

/** Códigos de error propios de las rutas de ventas (spec 013). Los de acceso (404, 409 archivado, 400) son de `AccesoError`. */
export type CodigoVentas =
  | "duplicado"
  | "venta_descuadrada"
  | "venta_no_quitable"
  | "salto_fuera_de_faltante"
  | "resumen_fuera_de_rango"
  | "layout_no_oficial"
  | "propuesta_demasiado_grande"
  | "filas_con_errores"
  | "archivo_invalido"
  | "columnas_faltantes"
  | "archivo_demasiado_grande";

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
  // D6: el layout de importación es provisional (`oficial: false`) y en producción no se usa.
  layout_no_oficial: HttpStatus.UNPROCESSABLE_ENTITY,
  // D10, P-9: más de 20.000 filas en el archivo o en el periodo tras complementar.
  propuesta_demasiado_grande: HttpStatus.UNPROCESSABLE_ENTITY,
  // D3, D6: confirmar es todo o nada; con una fila con error no se guarda nada.
  filas_con_errores: HttpStatus.UNPROCESSABLE_ENTITY,
  // El lector de archivos de 007b (los mismos códigos y estados que la importación de clientes).
  archivo_invalido: HttpStatus.BAD_REQUEST,
  columnas_faltantes: HttpStatus.BAD_REQUEST,
  archivo_demasiado_grande: HttpStatus.PAYLOAD_TOO_LARGE,
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

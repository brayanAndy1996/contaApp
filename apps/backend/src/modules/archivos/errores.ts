import { HttpException, HttpStatus } from "@nestjs/common";
import type { ErrorPrevioDto } from "@contapp/shared";

/** Códigos propios de las rutas de archivos (spec 012b). Los de acceso (400, 404, 409 archivado) son de `AccesoError`. */
export type CodigoArchivos =
  | "prevalidacion_fallida"
  | "formato_no_oficial"
  | "resumen_cambiado"
  | "estado_invalido"
  | "archivo_alterado";

const ESTADO: Record<CodigoArchivos, number> = {
  // D1, CA-3: la lista de filas con error viaja en el cuerpo para mostrarse.
  prevalidacion_fallida: HttpStatus.UNPROCESSABLE_ENTITY,
  // D2: producción con solo formatos provisionales.
  formato_no_oficial: HttpStatus.UNPROCESSABLE_ENTITY,
  // P-2: la huella del previo ya no coincide con los datos.
  resumen_cambiado: HttpStatus.CONFLICT,
  // D5: el `estadoVisto` ya no es el vigente (también con el periodo `generado`).
  estado_invalido: HttpStatus.CONFLICT,
  // D8: el ZIP guardado no coincide con su hash (o falta): nunca se entregan bytes.
  archivo_alterado: HttpStatus.INTERNAL_SERVER_ERROR,
};

/** Lo único que un error de archivos agrega a `{ codigo }`: la lista de errores de prevalidación del 422. */
export interface DetalleArchivos {
  errores?: readonly ErrorPrevioDto[];
  erroresOmitidos?: number;
}

/**
 * Error de archivos: cuerpo `{ codigo }` más, en `prevalidacion_fallida`, `errores` y `erroresOmitidos` (la lista existe para
 * mostrarse; nunca lleva rutas, hashes ni bytes). El filtro global responde `cuerpo` tal cual.
 */
export class ArchivosError extends HttpException {
  readonly codigo: CodigoArchivos;
  readonly cuerpo: { codigo: CodigoArchivos } & DetalleArchivos;

  constructor(codigo: CodigoArchivos, detalle: DetalleArchivos = {}) {
    const cuerpo: { codigo: CodigoArchivos } & DetalleArchivos = { codigo };
    if (detalle.errores !== undefined) cuerpo.errores = [...detalle.errores];
    if (detalle.erroresOmitidos !== undefined) cuerpo.erroresOmitidos = detalle.erroresOmitidos;
    super(cuerpo, ESTADO[codigo]);
    this.name = "ArchivosError";
    this.codigo = codigo;
    this.cuerpo = cuerpo;
  }
}

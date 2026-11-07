// Errores de la descarga de la propuesta (spec 013, D3). Son `ErrorDatos` (no se reintentan; el trabajo queda
// `error/datos_invalidos`) y el código fino va en `detalle`, un literal fijo: nunca lleva el contenido de una fila.
import { ErrorDatos } from "@contapp/sunat";

export type DetalleErrorPropuesta =
  | "libro_no_soportado"
  | "parametros_invalidos"
  | "usuario_requerido"
  | "respuesta_inconsistente"
  | "fila_invalida"
  | "propuesta_demasiado_grande";

export class ErrorPropuesta extends ErrorDatos {
  constructor(readonly detalle: DetalleErrorPropuesta) {
    super();
  }
}

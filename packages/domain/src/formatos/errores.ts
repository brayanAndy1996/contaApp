// Errores de formatos/ (plan 012, Contratos): `codigo` estable y mensaje fijo, sin valores de la
// entrada (nunca RUC, periodo, id ni nombres).
import type { ResultadoPrevalidacion } from "../prevalidacion/tipos";

export class FormatosError extends Error {
  readonly codigo: string;

  constructor(codigo: string, mensaje: string) {
    super(mensaje);
    this.name = new.target.name;
    this.codigo = codigo;
  }
}

/** No hay versión del libro vigente en el periodo, el libro no tiene formatos o el periodo es inválido. */
export class FormatoNoVigenteError extends FormatosError {
  constructor() {
    super("FORMATO_NO_VIGENTE", "No hay un formato vigente para el libro y el periodo.");
  }
}

/** Definición de formato incoherente o registro inválido. */
export class DefinicionFormatoInvalidaError extends FormatosError {
  constructor() {
    super("DEFINICION_FORMATO_INVALIDA", "Definición de formato inválida.");
  }
}

/** Componentes del nombre de archivo fuera de la gramática del formato (D7). */
export class NombreArchivoInvalidoError extends FormatosError {
  constructor() {
    super("NOMBRE_ARCHIVO_INVALIDO", "Nombre de archivo inválido.");
  }
}

/** El formato elegido es `oficial: false` y quien llama no pasó `permitirProvisional: true` (D5). */
export class FormatoProvisionalError extends FormatosError {
  constructor() {
    super("FORMATO_PROVISIONAL", "El formato vigente es provisional y no se permitió generarlo.");
  }
}

/**
 * La prevalidación no es apta (D4, CA-7): no hay bytes. `resultado` es el ResultadoPrevalidacion
 * congelado, con la lista de filas por corregir; el mensaje no lleva datos.
 */
export class ArchivoNoPrevalidadoError extends FormatosError {
  readonly resultado: ResultadoPrevalidacion;

  constructor(resultado: ResultadoPrevalidacion) {
    super("ARCHIVO_NO_PREVALIDADO", "Las filas no pasan la prevalidación: corrígelas o exclúyelas.");
    this.resultado = resultado;
  }
}

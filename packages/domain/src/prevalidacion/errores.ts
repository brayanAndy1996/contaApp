// Errores de prevalidacion/ (plan 012, Contratos y Decisiones «Errores frente a excepciones»):
// `codigo` estable y mensaje fijo, sin valores de la entrada. Un dato corregible nunca lanza: es un
// ErrorPrevalidacion; solo una forma imposible lanza.
import type { Destino } from "../comprobante/index";
import type { Money } from "../dinero/index";
import type { Hallazgo } from "../reglas/index";
import type { CodigoError, ErrorPrevalidacion } from "./tipos";

export class PrevalidacionError extends Error {
  readonly codigo: string;

  constructor(codigo: string, mensaje: string) {
    super(mensaje);
    this.name = new.target.name;
    this.codigo = codigo;
  }
}

/** Forma imposible en filas, cabecera, contexto u opciones (no un dato que el contador corrige). */
export class EntradaPrevalidacionInvalidaError extends PrevalidacionError {
  constructor() {
    super("ENTRADA_INVALIDA", "Entrada de prevalidación inválida.");
  }
}

/** ErrorPrevalidacion nuevo y congelado; lo que no se da queda en `null`. */
export function crearError(e: {
  filaId: string | null;
  codigo: CodigoError;
  campo: string | null;
  explicacion: string;
  destino?: Destino;
  diferencia?: Money;
  sugerencia?: Hallazgo;
}): ErrorPrevalidacion {
  return Object.freeze({
    filaId: e.filaId,
    codigo: e.codigo,
    campo: e.campo,
    destino: e.destino ?? null,
    explicacion: e.explicacion,
    diferencia: e.diferencia ?? null,
    sugerencia: e.sugerencia ?? null,
  });
}

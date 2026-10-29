// Errores de reglas/ (plan 011, Contratos): `codigo` estable y mensaje fijo, sin valores (nunca
// montos, documentos ni texto del XML). Los errores de 010 (DineroError) se propagan sin envolver.
export class ReglasError extends Error {
  readonly codigo: string;

  constructor(codigo: string, mensaje: string) {
    super(mensaje);
    this.name = new.target.name;
    this.codigo = codigo;
  }
}

/** Forma, gramática o marca de 010 inválida en filas, contexto, hallazgo o lecturas. */
export class EntradaReglasInvalidaError extends ReglasError {
  constructor() {
    super("ENTRADA_INVALIDA", "Entrada de reglas inválida.");
  }
}

/** Los montos ya no son los que la regla leyó al evaluar (CA-9). */
export class SugerenciaObsoletaError extends ReglasError {
  constructor() {
    super("SUGERENCIA_OBSOLETA", "La sugerencia ya no corresponde a los montos.");
  }
}

/** Falta el dato que pide el hallazgo o no es válido (p. ej. gravado fuera del rango). */
export class ConfirmacionInvalidaError extends ReglasError {
  constructor() {
    super("CONFIRMACION_INVALIDA", "Confirmación ausente o inválida.");
  }
}

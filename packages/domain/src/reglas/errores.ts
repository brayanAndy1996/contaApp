// STUB de T4 (tester): T9 lo reemplaza con la versión real.
export class ReglasError extends Error {
  readonly codigo: string;
  constructor(codigo: string, mensaje: string) {
    super(mensaje);
    this.name = new.target.name;
    this.codigo = codigo;
  }
}
export class EntradaReglasInvalidaError extends ReglasError {
  constructor() { super("ENTRADA_INVALIDA", "Entrada de reglas inválida."); }
}
export class SugerenciaObsoletaError extends ReglasError {
  constructor() { super("SUGERENCIA_OBSOLETA", "La sugerencia ya no corresponde a los montos."); }
}
export class ConfirmacionInvalidaError extends ReglasError {
  constructor() { super("CONFIRMACION_INVALIDA", "Confirmación ausente o inválida."); }
}

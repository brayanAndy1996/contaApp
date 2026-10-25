// Errores del dominio de dinero. Mensajes fijos: nunca incluyen el valor recibido.

export class DineroError extends Error {
  readonly codigo: string;

  constructor(codigo: string, mensaje: string) {
    super(mensaje);
    this.name = new.target.name;
    this.codigo = codigo;
  }
}

export class MontoInvalidoError extends DineroError {
  constructor() {
    super(
      "MONTO_INVALIDO",
      "Monto inválido: se espera un string canónico con punto decimal y a lo más 2 decimales.",
    );
  }
}

export class MontoFueraDeRangoError extends DineroError {
  constructor() {
    super(
      "MONTO_FUERA_DE_RANGO",
      "Monto fuera de rango: el límite es ±999999999999.99 (NUMERIC(14,2)).",
    );
  }
}

export class MonedaDistintaError extends DineroError {
  constructor() {
    super(
      "MONEDA_DISTINTA",
      "No se puede operar entre montos de monedas distintas.",
    );
  }
}

export class FactorInvalidoError extends DineroError {
  constructor() {
    super(
      "FACTOR_INVALIDO",
      "Factor o tipo de cambio inválido para la operación.",
    );
  }
}

export class MovimientoInvalidoError extends DineroError {
  constructor() {
    super(
      "MOVIMIENTO_INVALIDO",
      "Movimiento de monto inválido entre columnas.",
    );
  }
}

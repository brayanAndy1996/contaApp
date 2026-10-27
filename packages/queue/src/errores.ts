// Errores de la cola con `codigo` estable (plan 008). El `message` es fijo: nunca lleva valores de
// entrada (parámetros, ids ni secretos).

export abstract class ErrorCola extends Error {
  abstract readonly codigo: string;
  protected constructor(mensaje: string) {
    super(mensaje);
    this.name = new.target.name;
  }
}

/** El tipo no está en el catálogo (falla cerrado, CA-15). */
export class TipoDesconocidoError extends ErrorCola {
  readonly codigo = "tipo_desconocido";
  constructor() {
    super("Tipo de trabajo desconocido");
  }
}

/** Definición de tipo mal formada o en conflicto con una ya registrada. */
export class TipoInvalidoError extends ErrorCola {
  readonly codigo = "tipo_invalido";
  constructor() {
    super("Definición de tipo de trabajo inválida");
  }
}

/** Los parámetros no cumplen el esquema del tipo (sin valores en el mensaje). */
export class ParametrosInvalidosError extends ErrorCola {
  readonly codigo = "parametros_invalidos";
  constructor() {
    super("Parámetros de trabajo inválidos");
  }
}

/** El estudio llegó a `max_pendientes_tenant` en esa cola (HTTP 429, D8). */
export class ColaLlenaError extends ErrorCola {
  readonly codigo = "cola_llena";
  constructor() {
    super("La cola del estudio está llena");
  }
}

/** La cola del tipo no tiene fila en `config_sistema`: no se encola lo que nunca se despacharía. */
export class ColaNoConfiguradaError extends ErrorCola {
  readonly codigo = "cola_no_configurada";
  constructor() {
    super("La cola no tiene configuración");
  }
}

/** El cliente no existe en el estudio del contexto (RLS). */
export class ClienteDesconocidoError extends ErrorCola {
  readonly codigo = "cliente_no_encontrado";
  constructor() {
    super("Cliente no encontrado");
  }
}

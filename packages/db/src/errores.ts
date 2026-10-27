// Errores públicos de @contapp/db. Los mensajes son fijos: nunca incluyen el valor recibido
// (podría ser un intento de inyección o un dato sensible) ni la URL de conexión.

/** El contexto de tenant/usuario no es válido (falta, no es un UUID, tipo incorrecto). */
export class ContextoInvalidoError extends Error {
  constructor() {
    super("Contexto de tenant o usuario inválido");
    this.name = "ContextoInvalidoError";
  }
}

/** Se llamó a withTenant/withUsuario dentro de otro withTenant/withUsuario. */
export class WithTenantAnidadoError extends Error {
  constructor() {
    super("withTenant/withUsuario no se puede anidar");
    this.name = "WithTenantAnidadoError";
  }
}

/** Configuración de createDb inválida (rol fuera de la lista cerrada, falta DATABASE_URL). */
export class ConfiguracionDbError extends Error {
  constructor(motivo: "rol" | "url") {
    super(
      motivo === "rol"
        ? "rolApp no permitido para createDb"
        : "Falta DATABASE_URL para createDb",
    );
    this.name = "ConfiguracionDbError";
  }
}

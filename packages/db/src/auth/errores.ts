// STUB de T5 (rojo): contrato de AuthRepoError. La implementación es de T9.
// Contrato: del error de `pg` solo conserva el SQLSTATE (`codigo`); sin detail, where, constraint, cause...

export class AuthRepoError extends Error {
  /** SQLSTATE de PostgreSQL o "desconocido". */
  readonly codigo: string;

  constructor(codigo: string) {
    super(`Error de base de datos en autenticación (SQLSTATE ${codigo})`);
    this.name = "AuthRepoError";
    this.codigo = codigo;
  }

  static desde(error: unknown): AuthRepoError {
    void error;
    throw new Error("AuthRepoError.desde: no implementado (T9)");
  }
}

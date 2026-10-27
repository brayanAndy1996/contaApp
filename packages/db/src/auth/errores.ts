// Error de AuthRepo (CA-10): del error de `pg` solo conserva el SQLSTATE. Sin message original, detail,
// where, constraint, table, column ni cause: pueden contener datos de la fila (hashes, correos).

const SQLSTATE = /^[0-9A-Z]{5}$/;

export class AuthRepoError extends Error {
  /** SQLSTATE de PostgreSQL o "desconocido". */
  readonly codigo: string;

  constructor(codigo: string) {
    super(`Error de base de datos en autenticación (SQLSTATE ${codigo})`);
    this.codigo = codigo;
  }

  /** Reduce cualquier error a su SQLSTATE (si lo tiene y es válido). */
  static desde(error: unknown): AuthRepoError {
    const code =
      typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    return new AuthRepoError(typeof code === "string" && SQLSTATE.test(code) ? code : "desconocido");
  }
}

// En el prototipo (no como propiedad propia): las claves propias del error son solo `codigo`.
Object.defineProperty(AuthRepoError.prototype, "name", {
  value: "AuthRepoError",
  enumerable: false,
  configurable: true,
  writable: true,
});

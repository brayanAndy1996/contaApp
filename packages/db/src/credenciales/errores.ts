// Error de los repositorios de credenciales (spec 003, CA-9). Del error de `pg` solo conserva el
// SQLSTATE: nunca `detail` (puede traer la fila fallida con bytes del sobre), `where`, `constraint`,
// nombres de columnas/tablas ni `cause`. El mensaje es fijo.

const SQLSTATE = /^[0-9A-Z]{5}$/;

export class CredencialRepoError extends Error {
  /** SQLSTATE de PostgreSQL (p. ej. "42501", "23514") o "desconocido" si el error no trae uno. */
  readonly codigo: string;

  constructor(codigo: string) {
    super(`Error de base de datos en credenciales (SQLSTATE ${codigo})`);
    this.name = "CredencialRepoError";
    this.codigo = codigo;
  }

  /** Reduce cualquier error lanzado por `pg` a su SQLSTATE. */
  static desde(error: unknown): CredencialRepoError {
    const code =
      typeof error === "object" && error !== null
        ? (error as { code?: unknown }).code
        : undefined;
    return new CredencialRepoError(
      typeof code === "string" && SQLSTATE.test(code) ? code : "desconocido",
    );
  }
}

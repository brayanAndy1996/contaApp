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

/** Rechazos de negocio estables de las funciones de plataforma (006, plan.md "Ratificaciones"). */
export type MotivoPlataforma = "plan_inactivo" | "extra_sobre_tope" | "no_encontrado";
const MOTIVOS_PLATAFORMA: readonly string[] = ["plan_inactivo", "extra_sobre_tope", "no_encontrado"];

/**
 * Rechazo de negocio de una función de plataforma (SQLSTATE P0001 con mensaje estable), ya validadas la sesión y el
 * alta: estudio, suscripción o plan inexistente (404), plan inactivo (409) o adicionales sobre el tope (400). Solo
 * conserva el motivo (de una lista cerrada), nunca el texto del error original.
 */
export class PlataformaReglaError extends AuthRepoError {
  readonly motivo: MotivoPlataforma;

  constructor(motivo: MotivoPlataforma) {
    super("P0001");
    this.motivo = motivo;
  }

  /** PlataformaReglaError si el error es uno de los rechazos estables; si no, AuthRepoError (solo SQLSTATE). */
  static desde(error: unknown): AuthRepoError {
    if (typeof error === "object" && error !== null) {
      const { code, message } = error as { code?: unknown; message?: unknown };
      if (code === "P0001" && typeof message === "string" && MOTIVOS_PLATAFORMA.includes(message)) {
        return new PlataformaReglaError(message as MotivoPlataforma);
      }
    }
    return AuthRepoError.desde(error);
  }
}

// En el prototipo (no como propiedad propia): las claves propias del error son solo `codigo` (y `motivo`).
for (const [clase, nombre] of [
  [AuthRepoError, "AuthRepoError"],
  [PlataformaReglaError, "PlataformaReglaError"],
] as const) {
  Object.defineProperty(clase.prototype, "name", {
    value: nombre,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

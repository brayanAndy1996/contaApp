// Errores de los repositorios de `acceso` (spec 005). Mismo patrón que AuthRepoError (004, CA-14): del error
// de `pg` solo se conserva el SQLSTATE; sin message original, detail, where, constraint, table, column ni cause.
import type { Tx } from "../with-tenant";

const SQLSTATE = /^[0-9A-Z]{5}$/;

export type TxConsulta = Pick<Tx, "query">;

export class AccesoRepoError extends Error {
  /** SQLSTATE de PostgreSQL (p. ej. P0001 del trigger del último Dueño) o "desconocido". */
  readonly codigo: string;

  constructor(codigo: string) {
    super(`Error de base de datos en acceso (SQLSTATE ${codigo})`);
    this.codigo = codigo;
  }

  /** Reduce cualquier error a su SQLSTATE (si lo tiene y es válido). */
  static desde(error: unknown): AccesoRepoError {
    const code =
      typeof error === "object" && error !== null
        ? (error as { code?: unknown }).code
        : undefined;
    return new AccesoRepoError(
      typeof code === "string" && SQLSTATE.test(code) ? code : "desconocido",
    );
  }
}

export type MotivoRegla = "miembro_no_asignable" | "anterior_requerido";

/**
 * Regla de negocio rechazada por un repositorio (plan 005, packages/db): miembro desactivado (409) o falta
 * `anterior` habiendo otro responsable (400). Sin datos de entrada.
 */
export class AccesoReglaError extends Error {
  readonly motivo: MotivoRegla;

  constructor(motivo: MotivoRegla) {
    super(`Regla de acceso: ${motivo}`);
    this.motivo = motivo;
  }
}

// En el prototipo (no como propiedad propia): las claves propias del error son solo `codigo` / `motivo`.
for (const [clase, nombre] of [
  [AccesoRepoError, "AccesoRepoError"],
  [AccesoReglaError, "AccesoReglaError"],
] as const) {
  Object.defineProperty(clase.prototype, "name", {
    value: nombre,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Fila = Record<string, any>;

/**
 * Ejecuta una consulta parametrizada (texto estático) en la transacción de withTenant. Todo error de `pg` sale
 * como AccesoRepoError; AccesoReglaError pasa tal cual.
 */
export async function consultar(
  tx: TxConsulta,
  texto: string,
  valores: unknown[],
): Promise<Fila[]> {
  try {
    const r = await tx.query(texto, valores);
    return r.rows as Fila[];
  } catch (e) {
    throw AccesoRepoError.desde(e);
  }
}

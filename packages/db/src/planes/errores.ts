// Error de los repositorios de planes (spec 006). Mismo patrón que AccesoRepoError y TrabajosRepoError: del error de
// `pg` solo se conserva el SQLSTATE; nunca el mensaje original, detail, where, constraint, table, column ni cause.
import type { Tx } from "../with-tenant";

const SQLSTATE = /^[0-9A-Z]{5}$/;

export type TxConsulta = Pick<Tx, "query">;

export class PlanesRepoError extends Error {
  /** SQLSTATE de PostgreSQL o "desconocido". */
  readonly codigo: string;

  constructor(codigo: string) {
    super(`Error de base de datos en planes (SQLSTATE ${codigo})`);
    this.codigo = codigo;
  }

  /** Reduce cualquier error a su SQLSTATE (si lo tiene y es válido). */
  static desde(error: unknown): PlanesRepoError {
    const code =
      typeof error === "object" && error !== null
        ? (error as { code?: unknown }).code
        : undefined;
    return new PlanesRepoError(
      typeof code === "string" && SQLSTATE.test(code) ? code : "desconocido",
    );
  }
}

// En el prototipo (no como propiedad propia): las claves propias del error son solo `codigo`.
Object.defineProperty(PlanesRepoError.prototype, "name", {
  value: "PlanesRepoError",
  enumerable: false,
  configurable: true,
  writable: true,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Fila = Record<string, any>;

/** Consulta parametrizada (texto estático) en la tx de withTenant; todo error de `pg` sale como PlanesRepoError. */
export async function consultar(
  tx: TxConsulta,
  texto: string,
  valores: unknown[],
): Promise<Fila[]> {
  try {
    const r = await tx.query(texto, valores);
    return r.rows as Fila[];
  } catch (e) {
    throw PlanesRepoError.desde(e);
  }
}

// Error de los repositorios de trabajos (spec 008). Mismo patrón que CredencialRepoError y AccesoRepoError: del error
// de `pg` solo se conserva el SQLSTATE; nunca el mensaje original, detail, where, constraint, table, column ni cause
// (pueden traer la fila fallida, con parámetros del trabajo). El mensaje es fijo.
import type { Tx } from "../with-tenant";

const SQLSTATE = /^[0-9A-Z]{5}$/;

export type TxConsulta = Pick<Tx, "query">;

export class TrabajosRepoError extends Error {
  /** SQLSTATE de PostgreSQL (p. ej. "23505", "42501") o "desconocido" si el error no trae uno. */
  readonly codigo: string;

  constructor(codigo: string) {
    super(`Error de base de datos en trabajos (SQLSTATE ${codigo})`);
    this.name = "TrabajosRepoError";
    this.codigo = codigo;
  }

  /** Reduce cualquier error lanzado por `pg` a su SQLSTATE. */
  static desde(error: unknown): TrabajosRepoError {
    const code =
      typeof error === "object" && error !== null
        ? (error as { code?: unknown }).code
        : undefined;
    return new TrabajosRepoError(
      typeof code === "string" && SQLSTATE.test(code) ? code : "desconocido",
    );
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Fila = Record<string, any>;

/** Consulta parametrizada (texto estático) en la tx; todo error de `pg` sale como TrabajosRepoError. */
export async function consultar(
  tx: TxConsulta,
  texto: string,
  valores: unknown[],
): Promise<{ rows: Fila[]; rowCount: number }> {
  try {
    const r = await tx.query(texto, valores);
    return { rows: r.rows as Fila[], rowCount: r.rowCount ?? 0 };
  } catch (e) {
    throw TrabajosRepoError.desde(e);
  }
}

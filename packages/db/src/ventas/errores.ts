// Error de los repositorios de ventas (spec 013). Mismo patrón que TrabajosRepoError y CredencialRepoError: del
// error de `pg` solo se conserva el SQLSTATE; nunca el mensaje original, detail, where, constraint, table, column ni
// cause (pueden traer la fila fallida). El mensaje es fijo.
import type { Tx } from "../with-tenant";

const SQLSTATE = /^[0-9A-Z]{5}$/;

export type TxConsulta = Pick<Tx, "query">;

export class VentasRepoError extends Error {
  /** SQLSTATE de PostgreSQL (p. ej. "23505", "23514") o "desconocido" si el error no trae uno. */
  readonly codigo: string;

  constructor(codigo: string) {
    super(`Error de base de datos en ventas (SQLSTATE ${codigo})`);
    this.name = "VentasRepoError";
    this.codigo = codigo;
  }

  /** Reduce cualquier error lanzado por `pg` a su SQLSTATE. */
  static desde(error: unknown): VentasRepoError {
    const code =
      typeof error === "object" && error !== null
        ? (error as { code?: unknown }).code
        : undefined;
    return new VentasRepoError(
      typeof code === "string" && SQLSTATE.test(code) ? code : "desconocido",
    );
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Fila = Record<string, any>;

/** Consulta parametrizada (texto estático) en la tx; todo error de `pg` sale como VentasRepoError. */
export async function consultar(
  tx: TxConsulta,
  texto: string,
  valores: unknown[],
): Promise<{ rows: Fila[]; rowCount: number }> {
  try {
    const r = await tx.query(texto, valores);
    return { rows: r.rows as Fila[], rowCount: r.rowCount ?? 0 };
  } catch (e) {
    throw VentasRepoError.desde(e);
  }
}

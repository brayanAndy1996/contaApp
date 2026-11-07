// Errores de los repositorios de compras (spec 014). Dos clases distintas:
//  - ComprasRepoError: error de base de datos. Mismo patrón que VentasRepoError y PropuestasRepoError: del error de `pg` solo se
//    conserva el SQLSTATE; nunca el mensaje original, detail, where, constraint, table, column ni cause (pueden traer la fila).
//  - ComprasReglaError: incumplimiento de una regla de negocio que el backend traduce a HTTP (version_obsoleta, fila_excluida,
//    fila_cambiada, duplicado, no_descartable, no_encontrada, nada_que_deshacer, nada_que_rehacer y los rechazos de `transformar`).
//    El mensaje es fijo: lleva el código y nunca los ids ni datos de la fila.
import type { Tx } from "../with-tenant";

const SQLSTATE = /^[0-9A-Z]{5}$/;

export type TxConsulta = Pick<Tx, "query">;

export class ComprasRepoError extends Error {
  /** SQLSTATE de PostgreSQL (p. ej. "23505", "22003") o "desconocido" si el error no trae uno. */
  readonly codigo: string;

  constructor(codigo: string) {
    super(`Error de base de datos en compras (SQLSTATE ${codigo})`);
    this.name = "ComprasRepoError";
    this.codigo = codigo;
  }

  /** Reduce cualquier error lanzado por `pg` a su SQLSTATE. */
  static desde(error: unknown): ComprasRepoError {
    const code =
      typeof error === "object" && error !== null
        ? (error as { code?: unknown }).code
        : undefined;
    return new ComprasRepoError(
      typeof code === "string" && SQLSTATE.test(code) ? code : "desconocido",
    );
  }
}

export interface DetalleRegla {
  /** `version_obsoleta`: la versión vigente de la fila. */
  versionVigente?: number;
  /** `fila_cambiada` y `duplicado`: las filas implicadas. */
  ids?: readonly string[];
}

export class ComprasReglaError extends Error {
  readonly codigo: string;
  readonly versionVigente?: number;
  readonly ids?: readonly string[];

  constructor(codigo: string, detalle: DetalleRegla = {}) {
    super(`Regla de compras incumplida: ${codigo}`);
    this.name = "ComprasReglaError";
    this.codigo = codigo;
    if (detalle.versionVigente !== undefined)
      this.versionVigente = detalle.versionVigente;
    if (detalle.ids !== undefined) this.ids = detalle.ids;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Fila = Record<string, any>;

/** Consulta parametrizada (texto estático) en la tx; todo error de `pg` sale como ComprasRepoError. */
export async function consultar(
  tx: TxConsulta,
  texto: string,
  valores: unknown[] = [],
): Promise<{ rows: Fila[]; rowCount: number }> {
  try {
    const r = await tx.query(texto, valores);
    return { rows: r.rows as Fila[], rowCount: r.rowCount ?? 0 };
  } catch (e) {
    throw ComprasRepoError.desde(e);
  }
}

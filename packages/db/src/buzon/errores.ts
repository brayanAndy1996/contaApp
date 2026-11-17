// Error de los repositorios de buzones (spec 023). Mismo patrón que TrabajosRepoError: del error de `pg` solo se conserva el
// SQLSTATE; nunca el mensaje, detail, where, constraint, table ni column (pueden traer asunto, nombre de adjunto o ruta).
// STUB de T4 (rojo): T11 lo completa si hace falta; las pruebas de `buzon/*.spec.ts` fijan su contrato.
import type { Tx } from "../with-tenant";

export type TxConsulta = Pick<Tx, "query">;

export class BuzonRepoError extends Error {
  /** SQLSTATE de PostgreSQL (p. ej. "23503", "42501", "22023") o "desconocido". */
  readonly codigo: string;

  constructor(codigo: string) {
    super(`Error de base de datos en buzón (SQLSTATE ${codigo})`);
    this.name = "BuzonRepoError";
    this.codigo = codigo;
  }

  static desde(error: unknown): BuzonRepoError {
    const code =
      typeof error === "object" && error !== null
        ? (error as { code?: unknown }).code
        : undefined;
    return new BuzonRepoError(
      typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)
        ? code
        : "desconocido",
    );
  }
}

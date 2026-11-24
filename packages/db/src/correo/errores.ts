/* eslint-disable @typescript-eslint/no-unused-vars -- stub en rojo de T4 (spec 028): T10 lo reemplaza */
// STUB (spec 028, T4 rojo): lo reemplaza T10. Error del repositorio de correo: de todo error de `pg` solo conserva el SQLSTATE
// (P0002, CA430, 22023, 42501, 55000...) o "desconocido"; nunca mensaje, detalle, tabla ni columna (pueden traer correos, razones
// sociales o tokens de baja; R-8). Mismo patrón que `GastosRepoError`.
import type { Tx } from "../with-tenant";

export type TxConsulta = Pick<Tx, "query">;

export class CorreoRepoError extends Error {
  /** SQLSTATE de PostgreSQL o "desconocido". */
  readonly codigo: string;
  constructor(codigo: string) {
    super(`Error de base de datos en correo (SQLSTATE ${codigo})`);
    this.name = "CorreoRepoError";
    this.codigo = codigo;
  }
  /** Reduce cualquier error lanzado por `pg` a su SQLSTATE. */
  static desde(_error: unknown): CorreoRepoError {
    throw new Error("no implementado: CorreoRepoError.desde");
  }
}

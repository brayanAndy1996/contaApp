// Error del repositorio de correo (spec 028): de todo error de `pg` solo conserva el SQLSTATE (P0002, CA430, 22023, 42501, 55000...) o
// "desconocido"; nunca mensaje, detalle, tabla ni columna (pueden traer correos, razones sociales o tokens de baja; R-8). Mismo patrón que
// `GastosRepoError`. Las validaciones de forma de este archivo son la última barrera antes de la BD: un id mal formado es P0002 y un
// argumento de tipo equivocado 22023, sin ir a la BD.
import type { Tx } from "../with-tenant";

export type TxConsulta = Pick<Tx, "query">;

const SQLSTATE = /^[0-9A-Z]{5}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 22023 = invalid_parameter_value. */
export const ARGUMENTO_INVALIDO = "22023";
/** P0002 = no_data_found: id ajeno, inexistente o mal formado. */
export const NO_ENCONTRADO = "P0002";
/** 42501 = insufficient_privilege: sin usuario o sin membresía activa en la sesión. */
export const SIN_PERMISO = "42501";

export class CorreoRepoError extends Error {
  /** SQLSTATE de PostgreSQL o "desconocido". */
  readonly codigo: string;
  constructor(codigo: string) {
    super(`Error de base de datos en correo (SQLSTATE ${codigo})`);
    this.name = "CorreoRepoError";
    this.codigo = codigo;
  }
  /** Reduce cualquier error lanzado por `pg` a su SQLSTATE. */
  static desde(error: unknown): CorreoRepoError {
    if (error instanceof CorreoRepoError) return error;
    const code: unknown = (Object(error) as { code?: unknown }).code;
    return new CorreoRepoError(
      typeof code === "string" && SQLSTATE.test(code) ? code : "desconocido",
    );
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FilaCorreo = Record<string, any>;

/** Consulta parametrizada (texto estático) en la tx; todo error sale como CorreoRepoError con solo su SQLSTATE. */
export async function consultarCorreo(
  tx: TxConsulta,
  texto: string,
  valores: unknown[],
): Promise<FilaCorreo[]> {
  try {
    const r = await tx.query(texto, valores);
    return r.rows as FilaCorreo[];
  } catch (e) {
    throw CorreoRepoError.desde(e);
  }
}

/** Un id que no es uuid no existe: P0002 sin ir a la BD. */
export function exigirIdCorreo(v: unknown): string {
  if (typeof v !== "string" || !UUID.test(v))
    throw new CorreoRepoError(NO_ENCONTRADO);
  return v;
}

/** AAAA-MM-DD de un día que existe (sin hora ni zona); si no, 22023. */
export function exigirDia(v: unknown): string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v))
    throw new CorreoRepoError(ARGUMENTO_INVALIDO);
  const d = new Date(`${v}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v)
    throw new CorreoRepoError(ARGUMENTO_INVALIDO);
  return v;
}

/** Entero en [min, max]; si no, 22023. */
export function exigirEntero(v: unknown, min: number, max: number): number {
  if (
    typeof v !== "number" ||
    !Number.isSafeInteger(v) ||
    v < min ||
    v > max
  )
    throw new CorreoRepoError(ARGUMENTO_INVALIDO);
  return v;
}

/** Fecha válida (Date); si no, 22023. */
export function exigirFecha(v: unknown): Date {
  if (!(v instanceof Date) || Number.isNaN(v.getTime()))
    throw new CorreoRepoError(ARGUMENTO_INVALIDO);
  return v;
}

/** Fecha de la BD (Date o texto ISO) o null. */
export const fechaONull = (v: unknown): Date | null =>
  v === null || v === undefined ? null : new Date(v as string | Date);

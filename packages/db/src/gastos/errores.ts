// Error del repositorio de gastos no deducibles (spec 027). De todo error de `pg` solo se conserva el SQLSTATE (P0002, 55000, CA409,
// CA420-CA423, 22023, 42501...) o "desconocido"; nunca el mensaje, el detalle ni la tabla (pueden traer palabras del estudio, RUC o
// glosas). El mensaje es fijo. Las validaciones de forma de este archivo son la última barrera antes de la BD: un id mal formado es
// P0002 y un argumento de tipo equivocado 22023, sin ir a la BD (así nunca llega un 22P02).
import type { TxConsulta } from "../compras/errores";

const SQLSTATE = /^[0-9A-Z]{5}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 22023 = invalid_parameter_value. */
export const ARGUMENTO_INVALIDO = "22023";
/** P0002 = no_data_found: id ajeno, inexistente o mal formado. */
export const NO_ENCONTRADO = "P0002";

export class GastosRepoError extends Error {
  readonly codigo: string;
  constructor(codigo: string) {
    super(`Error de base de datos en gastos (SQLSTATE ${codigo})`);
    this.name = "GastosRepoError";
    this.codigo = codigo;
  }
  /** Reduce cualquier error lanzado por `pg` a su SQLSTATE. */
  static desde(error: unknown): GastosRepoError {
    const code: unknown = (Object(error) as { code?: unknown }).code;
    return new GastosRepoError(
      typeof code === "string" && SQLSTATE.test(code) ? code : "desconocido",
    );
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FilaGastos = Record<string, any>;

/** Consulta parametrizada (texto estático) en la tx; todo error sale como GastosRepoError con solo su SQLSTATE. */
export async function consultarGastos(
  tx: TxConsulta,
  texto: string,
  valores: unknown[],
): Promise<FilaGastos[]> {
  try {
    const r = await tx.query(texto, valores);
    return r.rows as FilaGastos[];
  } catch (e) {
    throw GastosRepoError.desde(e);
  }
}

/** `true` si el valor es un uuid en texto. */
export const esUuidGastos = (v: unknown): v is string =>
  typeof v === "string" && UUID.test(v);

/** Un id que no es uuid no existe: P0002 sin ir a la BD. */
export function exigirId(v: unknown): string {
  if (!esUuidGastos(v)) throw new GastosRepoError(NO_ENCONTRADO);
  return v;
}

export function exigirVersion(v: unknown): number {
  if (
    typeof v !== "number" ||
    !Number.isSafeInteger(v) ||
    v < 0 ||
    v > 2_147_483_646
  )
    throw new GastosRepoError(ARGUMENTO_INVALIDO);
  return v;
}

export function exigirBooleano(v: unknown): boolean {
  if (typeof v !== "boolean") throw new GastosRepoError(ARGUMENTO_INVALIDO);
  return v;
}

export function exigirTexto(v: unknown): string {
  if (typeof v !== "string") throw new GastosRepoError(ARGUMENTO_INVALIDO);
  return v;
}

export function exigirTextos(v: unknown): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string"))
    throw new GastosRepoError(ARGUMENTO_INVALIDO);
  return v as string[];
}

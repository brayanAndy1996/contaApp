// Error del repositorio de la prorrata (spec 026). De todo error de `pg` solo se conserva el SQLSTATE (P0002, 55000, CA409, CA412,
// CA413, 22023, 42501...) o "desconocido"; nunca el mensaje, el detalle ni la tabla (pueden traer RUC o montos). El mensaje es fijo.
import type { TxConsulta } from "../compras/errores";

const SQLSTATE = /^[0-9A-Z]{5}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 22023 = invalid_parameter_value: el llamador (HTTP o worker) valida antes; esto es la última barrera antes de la BD. */
export const ARGUMENTO_INVALIDO = "22023";

export class ProrrataRepoError extends Error {
  readonly codigo: string;
  constructor(codigo: string) {
    super(`Error de base de datos en prorrata (SQLSTATE ${codigo})`);
    this.name = "ProrrataRepoError";
    this.codigo = codigo;
  }
  /** Reduce cualquier error lanzado por `pg` a su SQLSTATE. */
  static desde(error: unknown): ProrrataRepoError {
    const code: unknown = (Object(error) as { code?: unknown }).code;
    return new ProrrataRepoError(
      typeof code === "string" && SQLSTATE.test(code) ? code : "desconocido",
    );
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FilaProrrata = Record<string, any>;

/** Consulta parametrizada (texto estático) en la tx; todo error sale como ProrrataRepoError con solo su SQLSTATE. */
export async function consultarProrrata(
  tx: TxConsulta,
  texto: string,
  valores: unknown[],
): Promise<FilaProrrata[]> {
  try {
    const r = await tx.query(texto, valores);
    return r.rows as FilaProrrata[];
  } catch (e) {
    throw ProrrataRepoError.desde(e);
  }
}

/** `true` si el valor es un uuid en texto: un id que no lo es no existe (las lecturas devuelven vacío sin ir a la BD). */
export const esUuidProrrata = (v: unknown): v is string =>
  typeof v === "string" && UUID.test(v);

/** Monto decimal con signo y hasta 2 decimales («-1234.5»); lo demás no llega a la BD (22023 en vez de 22P02). */
const MONTO = /^-?[0-9]{1,13}(\.[0-9]{1,2})?$/;
/** Porcentaje sin signo con hasta 2 decimales; el rango 0..100 lo decide la función acotada. */
const PORCENTAJE = /^-?[0-9]{1,4}(\.[0-9]{1,2})?$/;

export function exigirMonto(v: unknown): string {
  if (typeof v !== "string" || !MONTO.test(v))
    throw new ProrrataRepoError(ARGUMENTO_INVALIDO);
  return v;
}

export function exigirPorcentaje(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== "string" || !PORCENTAJE.test(v))
    throw new ProrrataRepoError(ARGUMENTO_INVALIDO);
  return v;
}

export function exigirVersion(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > 2_147_483_646)
    throw new ProrrataRepoError(ARGUMENTO_INVALIDO);
  return v;
}

/** Periodos como lista de cadenas (la BD solo encuentra los AAAAMM; el resto no coincide con nada). */
export function exigirPeriodos(v: unknown): string[] {
  if (!Array.isArray(v) || v.some((p) => typeof p !== "string"))
    throw new ProrrataRepoError(ARGUMENTO_INVALIDO);
  return v as string[];
}

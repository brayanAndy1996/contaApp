// Repos de sistema (spec 008, D16, D18). Se llaman con la `tx` de withSistema (contapp_worker sin estudio): las
// funciones `sistema.*` devuelven solo UUID y `auth.purgar` solo conteos. Nunca ven filas de negocio.
import { consultar, type Fila, type TxConsulta } from "./errores";

const SQL_ESTUDIOS = "select * from sistema.estudios_ids()";
const SQL_CON_TRABAJOS =
  "select * from sistema.estudios_con_trabajos($1::text[], $2::integer)";
const SQL_PURGAR_AUTH = `select sesiones, tokens, intentos, limites from auth.purgar(
  make_interval(days => $1::integer), make_interval(days => $2::integer),
  make_interval(days => $3::integer), make_interval(days => $4::integer))`;

/** Primera columna de cada fila (las funciones devuelven SETOF uuid; el nombre de la columna no importa). */
const uuids = (filas: Fila[]): string[] =>
  filas.map((f) => String(Object.values(f)[0]));

/** UUID de todos los estudios (kek.rotar, CA-12). */
export async function estudiosIds(tx: TxConsulta): Promise<string[]> {
  return uuids((await consultar(tx, SQL_ESTUDIOS, [])).rows);
}

/** Estudios con algún trabajo en `estados` y al menos `antiguedadSeg` segundos sin cambios (reconciliador). */
export async function estudiosConTrabajos(
  tx: TxConsulta,
  estados: readonly string[],
  antiguedadSeg: number,
): Promise<string[]> {
  const r = await consultar(tx, SQL_CON_TRABAJOS, [
    [...estados],
    antiguedadSeg,
  ]);
  return uuids(r.rows);
}

export interface RetencionesAuth {
  sesionDias: number;
  tokenDias: number;
  intentoDias: number;
  limiteDias: number;
}

export interface ConteosPurga {
  sesiones: number;
  tokens: number;
  intentos: number;
  limites: number;
}

/** auth.purgar con las retenciones en días (D16); < 1 día lo rechaza la función (TrabajosRepoError). */
export async function purgarAuth(
  tx: TxConsulta,
  r: RetencionesAuth,
): Promise<ConteosPurga> {
  const res = await consultar(tx, SQL_PURGAR_AUTH, [
    r.sesionDias,
    r.tokenDias,
    r.intentoDias,
    r.limiteDias,
  ]);
  // auth.purgar devuelve siempre una fila (RETURN NEXT); pg puede entregar los enteros como string.
  const f = res.rows[0]!;
  return {
    sesiones: Number(f.sesiones),
    tokens: Number(f.tokens),
    intentos: Number(f.intentos),
    limites: Number(f.limites),
  };
}

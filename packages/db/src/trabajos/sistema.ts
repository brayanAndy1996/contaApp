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

// ---- Spec 023 (D-5): candado del ciclo del programador del buzón SOL (funciones sistema.buzon_ciclo_* de 0055) y estudios con
// suscripción vigente. Todo el tiempo sale del reloj de la BD; los relojes de los workers no cuentan.
const SQL_ESTUDIOS_BUZON =
  "select tenant_id, frecuencia_min from sistema.estudios_buzon()";
const SQL_TOMAR_CICLO =
  "select ahora, intervalo_min, reserva_interactiva, lote_estudio from sistema.buzon_ciclo_tomar($1::text)";
const SQL_RENOVAR_CICLO = "select sistema.buzon_ciclo_renovar($1::text)";
const SQL_SOLTAR_CICLO = "select sistema.buzon_ciclo_soltar($1::text)";

export interface CicloBuzon {
  /** Reloj de la BD al tomar el ciclo. */
  ahora: Date;
  intervaloMin: number;
  reservaInteractiva: number;
  loteEstudio: number;
}

/** Estudios con suscripción activa o prueba vigente y la frecuencia de su plan (solo uuid y entero). */
export async function estudiosBuzon(
  tx: TxConsulta,
): Promise<{ tenantId: string; frecuenciaMin: number }[]> {
  const r = await consultar(tx, SQL_ESTUDIOS_BUZON, []);
  return r.rows.map((f) => ({
    tenantId: String(f.tenant_id),
    frecuenciaMin: Number(f.frecuencia_min),
  }));
}

/** Toma el ciclo (`null` si otro lo tiene o aún no toca por el intervalo). */
export async function tomarCiclo(
  tx: TxConsulta,
  dueno: string,
): Promise<CicloBuzon | null> {
  const f = (await consultar(tx, SQL_TOMAR_CICLO, [dueno])).rows[0];
  if (f === undefined) return null;
  return {
    ahora: f.ahora instanceof Date ? f.ahora : new Date(String(f.ahora)),
    intervaloMin: Number(f.intervalo_min),
    reservaInteractiva: Number(f.reserva_interactiva),
    loteEstudio: Number(f.lote_estudio),
  };
}

/** Extiende el candado; `false` si lo perdió (otro dueño o vencido). */
export async function renovarCiclo(
  tx: TxConsulta,
  dueno: string,
): Promise<boolean> {
  const f = (await consultar(tx, SQL_RENOVAR_CICLO, [dueno])).rows[0];
  return f !== undefined && Object.values(f)[0] === true;
}

/** Suelta el candado (fija ultimo_ciclo_fin); si `dueno` ya no lo tiene, no cambia nada. */
export async function soltarCiclo(
  tx: TxConsulta,
  dueno: string,
): Promise<void> {
  await consultar(tx, SQL_SOLTAR_CICLO, [dueno]);
}

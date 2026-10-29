// Arriendos con TTL (D5, D20, CA-10): cupo del estudio y global (ZSET jobId -> vencimiento), lock del
// RUC por canal (SET NX PX), arriendo del ejecutor (`ejec:{jobId}`). Nada de contadores: si el proceso
// muere, todo vence solo en ≤ 30 s. El despachador los toma; el ejecutor (worker) los renueva con un
// latido cada 10 s y los libera al terminar dejando el lock con PX = espera_ruc_ms.
import type { ClavesCola } from "./claves.js";
import { ARRIENDO_MS, LATIDO_MS, type ClienteRedis } from "./tipos.js";

export interface Arrendable {
  id: string;
  tenantId: string;
  cola: string;
  canal: string;
  ruc: string;
  /**
   * Dueño de esta ejecución (H-008-1b-3): valor de `ejec:{jobId}` que tomó el ejecutor. Con él, renovar, soltar y
   * liberar solo actúan mientras `ejec:{jobId}` sigue siendo suyo: un ejecutor cuyo arriendo venció (y cuyo trabajo
   * ya re-despachó otro proceso) no toca el lock, los cupos ni el `ejec` de la ejecución nueva. Sin él (despachador,
   * reconciliador) se actúa como siempre, sobre el valor `jobId`.
   */
  ejecucion?: string;
}

const conLock = (t: Arrendable): boolean => t.canal !== "ninguno";

/**
 * Hora del servidor Redis (`TIME`) en ms: la ÚNICA fuente de tiempo de los arriendos (H-008-1b-2, H-008-2b-1 a 2b-5).
 * Los vencimientos de los cupos se escriben con ella, y despachador y reconciliador podan y deciden "vencido" con ella:
 * un proceso con el reloj local adelantado o atrasado no alarga ni acorta un arriendo (el TTL de `ejec:` y del lock
 * también los mide Redis).
 */
export async function horaRedisMs(
  redis: Pick<ClienteRedis, "time">,
): Promise<number> {
  const [s, us] = await redis.time();
  return Number(s) * 1000 + Math.floor(Number(us) / 1000);
}

/** ¿Sigue `ejec:{jobId}` en manos de esta ejecución? Sin `ejecucion` no hay dueño que comprobar. */
async function esDueno(
  redis: Pick<ClienteRedis, "get">,
  k: ClavesCola,
  t: Arrendable,
): Promise<boolean> {
  if (t.ejecucion === undefined) return true;
  return (await redis.get(k.ejec(t.id))) === t.ejecucion;
}

/**
 * Poda un ZSET de cupo y cuenta los vivos. Un cupo vencido según `corteMs` solo se quita si su ejecutor ya no tiene
 * `ejec:{jobId}` (arriendo con TTL de Redis, el reloj común): un proceso con el reloj adelantado no borra el cupo de un
 * trabajo que otro proceso sigue ejecutando y renovando (H-008-1b-2).
 */
async function podar(
  redis: Pick<ClienteRedis, "zrangebyscore" | "zrem" | "exists" | "zcard">,
  k: ClavesCola,
  clave: string,
  corteMs: number,
): Promise<number> {
  for (const id of await redis.zrangebyscore(clave, "-inf", corteMs)) {
    if ((await redis.exists(k.ejec(id))) === 0) await redis.zrem(clave, id);
  }
  return redis.zcard(clave);
}

/** Clave del lock del RUC del trabajo en su canal, o null si su canal (`ninguno`) no usa lock (D20). */
export function claveLockRuc(
  k: ClavesCola,
  t: Pick<Arrendable, "canal" | "ruc">,
): string | null {
  return t.canal === "ninguno" ? null : k.lockRuc(t.canal, t.ruc);
}

/**
 * Quita los arriendos vencidos de un ZSET de cupo (ver `podar`) y devuelve cuántos siguen vivos. `ahoraMs` debe ser la
 * hora de Redis (`horaRedisMs`): despachador y reconciliador la toman de ahí, nunca del reloj local (H-008-2b-4).
 */
export async function cuposVivos(
  redis: Pick<ClienteRedis, "zrangebyscore" | "zrem" | "exists" | "zcard">,
  k: ClavesCola,
  clave: string,
  ahoraMs: number,
): Promise<number> {
  return podar(redis, k, clave, ahoraMs);
}

/**
 * Cupo del estudio y global hasta `TIME de Redis + 30 s`. `_ahoraMs` (hora local de quien llama) se ignora: con relojes
 * desfasados, la mayor entre las dos alargaba el arriendo de un proceso adelantado (H-008-2b-2).
 */
export async function tomarCupos(
  redis: Pick<ClienteRedis, "zadd" | "time">,
  k: ClavesCola,
  t: Arrendable,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- se conserva la firma; la hora es la de Redis
  _ahoraMs?: number,
): Promise<void> {
  const vence = (await horaRedisMs(redis)) + ARRIENDO_MS;
  await redis.zadd(k.cupoTenant(t.cola, t.tenantId), vence, t.id);
  await redis.zadd(k.cupoGlobal(t.cola), vence, t.id);
}

/** Límites de una reserva de cupos (config_sistema de la cola). */
export interface LimitesCupo {
  global: number;
  tenant: number;
}

/**
 * Reserva el cupo del estudio y el global ANTES de la transición `en_cola → ejecutando` (H-008-1b-1): agrega el
 * trabajo a los dos ZSET y luego cuenta los vivos; si alguno pasa su límite, deshace la reserva. Dos procesos que se
 * crean líderes a la vez (o un líder que siguió su ciclo tarde) nunca superan el límite: en el peor caso los dos se
 * retiran y el trabajo sale en el ciclo siguiente. `"global"`/`"tenant"` dice qué límite faltó.
 */
export async function reservarCupos(
  redis: Pick<
    ClienteRedis,
    "zadd" | "zrem" | "zrangebyscore" | "exists" | "zcard" | "time"
  >,
  k: ClavesCola,
  t: Arrendable,
  _ahoraMs: number,
  limites: LimitesCupo,
): Promise<true | "global" | "tenant"> {
  // Vence y poda con TIME de Redis (no con la hora local de quien reserva, H-008-2b-2/2b-4).
  const ahora = await horaRedisMs(redis);
  const vence = ahora + ARRIENDO_MS;
  const enTenant = k.cupoTenant(t.cola, t.tenantId);
  const enGlobal = k.cupoGlobal(t.cola);
  await redis.zadd(enTenant, vence, t.id);
  await redis.zadd(enGlobal, vence, t.id);
  const falta =
    (await podar(redis, k, enGlobal, ahora)) > limites.global
      ? "global"
      : (await podar(redis, k, enTenant, ahora)) > limites.tenant
        ? "tenant"
        : null;
  if (falta === null) return true;
  await soltarCupos(redis, k, t);
  return falta;
}

/** Quita el trabajo de los cupos del estudio y global (reserva deshecha). */
export async function soltarCupos(
  redis: Pick<ClienteRedis, "zrem">,
  k: ClavesCola,
  t: Arrendable,
): Promise<void> {
  await redis.zrem(k.cupoTenant(t.cola, t.tenantId), t.id);
  await redis.zrem(k.cupoGlobal(t.cola), t.id);
}

/** Lock global del RUC en su canal (D20). Un canal `ninguno` no se bloquea. */
export async function tomarLockRuc(
  redis: Pick<ClienteRedis, "set">,
  k: ClavesCola,
  t: Arrendable,
): Promise<boolean> {
  if (!conLock(t)) return true;
  const r = await redis.set(
    k.lockRuc(t.canal, t.ruc),
    t.id,
    "PX",
    ARRIENDO_MS,
    "NX",
  );
  return r === "OK";
}

/**
 * Suelta el lock solo si es de este trabajo (y, con `ejecucion`, solo si esa ejecución sigue siendo la dueña); con
 * espera > 0 lo deja vivo esa espera (D20).
 */
export async function soltarLockRuc(
  redis: Pick<ClienteRedis, "get" | "set" | "del">,
  k: ClavesCola,
  t: Arrendable,
  esperaRucMs = 0,
): Promise<void> {
  if (!conLock(t)) return;
  if (!(await esDueno(redis, k, t))) return;
  const clave = k.lockRuc(t.canal, t.ruc);
  if ((await redis.get(clave)) !== t.id) return;
  if (esperaRucMs > 0) await redis.set(clave, t.id, "PX", esperaRucMs);
  else await redis.del(clave);
}

/**
 * Arriendo del ejecutor: un solo proceso ejecuta un jobId a la vez. `valor` identifica la ejecución (por defecto el
 * jobId; el ejecutor pasa uno propio por intento, H-008-1b-3).
 */
export async function tomarEjecucion(
  redis: Pick<ClienteRedis, "set">,
  k: ClavesCola,
  jobId: string,
  valor: string = jobId,
): Promise<boolean> {
  return (
    (await redis.set(k.ejec(jobId), valor, "PX", ARRIENDO_MS, "NX")) === "OK"
  );
}

/**
 * Latido: extiende ejec, cupos y lock otros 30 s (cupos hasta TIME de Redis + 30 s; `_ahoraMs` se ignora, H-008-2b-2).
 * Devuelve false (sin renovar nada) si el arriendo del ejecutor ya no es de esta ejecución (venció: el reconciliador
 * pudo haber reasignado el trabajo, H-008-1b-3).
 */
export async function renovarArriendos(
  redis: Pick<ClienteRedis, "pexpire" | "zadd" | "get" | "time">,
  k: ClavesCola,
  t: Arrendable,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- se conserva la firma; la hora es la de Redis
  _ahoraMs?: number,
): Promise<boolean> {
  if ((await redis.get(k.ejec(t.id))) !== (t.ejecucion ?? t.id)) return false;
  const vivo = (await redis.pexpire(k.ejec(t.id), ARRIENDO_MS)) === 1;
  const vence = (await horaRedisMs(redis)) + ARRIENDO_MS;
  await redis.zadd(k.cupoTenant(t.cola, t.tenantId), "XX", vence, t.id);
  await redis.zadd(k.cupoGlobal(t.cola), "XX", vence, t.id);
  if (conLock(t)) {
    const clave = k.lockRuc(t.canal, t.ruc);
    if ((await redis.get(clave)) === t.id)
      await redis.pexpire(clave, ARRIENDO_MS);
  }
  return vivo;
}

/**
 * Al terminar: libera los cupos y el arriendo del ejecutor y deja el lock con PX = espera_ruc_ms. Con `ejecucion`,
 * solo si esa ejecución sigue siendo la dueña de `ejec:{jobId}`: si no, lo vivo es de otra ejecución y no se toca.
 */
export async function liberarArriendos(
  redis: Pick<ClienteRedis, "zrem" | "get" | "set" | "del">,
  k: ClavesCola,
  t: Arrendable,
  esperaRucMs: number,
): Promise<void> {
  if (!(await esDueno(redis, k, t))) return;
  await soltarCupos(redis, k, t);
  await soltarLockRuc(redis, k, t, esperaRucMs);
  if ((await redis.get(k.ejec(t.id))) === (t.ejecucion ?? t.id))
    await redis.del(k.ejec(t.id));
}

/** Ejecuta `renovar` cada `intervaloMs` hasta que se llame a la función devuelta. Errores ignorados. */
export function iniciarLatido(
  renovar: () => Promise<unknown>,
  intervaloMs: number = LATIDO_MS,
): () => void {
  const id = setInterval(() => {
    renovar().catch(() => undefined);
  }, intervaloMs);
  id.unref?.();
  return () => clearInterval(id);
}

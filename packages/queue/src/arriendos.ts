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
}

const conLock = (t: Arrendable): boolean => t.canal !== "ninguno";

/** Quita los arriendos vencidos de un ZSET de cupo y devuelve cuántos siguen vivos. */
export async function cuposVivos(
  redis: Pick<ClienteRedis, "zremrangebyscore" | "zcard">,
  clave: string,
  ahoraMs: number,
): Promise<number> {
  await redis.zremrangebyscore(clave, "-inf", ahoraMs);
  return redis.zcard(clave);
}

/** Cupo del estudio y global hasta `ahora + 30 s`. */
export async function tomarCupos(
  redis: Pick<ClienteRedis, "zadd">,
  k: ClavesCola,
  t: Arrendable,
  ahoraMs: number,
): Promise<void> {
  const vence = ahoraMs + ARRIENDO_MS;
  await redis.zadd(k.cupoTenant(t.cola, t.tenantId), vence, t.id);
  await redis.zadd(k.cupoGlobal(t.cola), vence, t.id);
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

/** Suelta el lock solo si es de este trabajo; con espera > 0 lo deja vivo esa espera (D20). */
export async function soltarLockRuc(
  redis: Pick<ClienteRedis, "get" | "set" | "del">,
  k: ClavesCola,
  t: Arrendable,
  esperaRucMs = 0,
): Promise<void> {
  if (!conLock(t)) return;
  const clave = k.lockRuc(t.canal, t.ruc);
  if ((await redis.get(clave)) !== t.id) return;
  if (esperaRucMs > 0) await redis.set(clave, t.id, "PX", esperaRucMs);
  else await redis.del(clave);
}

/** Arriendo del ejecutor: un solo proceso ejecuta un jobId a la vez. */
export async function tomarEjecucion(
  redis: Pick<ClienteRedis, "set">,
  k: ClavesCola,
  jobId: string,
): Promise<boolean> {
  return (
    (await redis.set(k.ejec(jobId), jobId, "PX", ARRIENDO_MS, "NX")) === "OK"
  );
}

/**
 * Latido: extiende ejec, cupos y lock otros 30 s. Devuelve false si el arriendo del ejecutor ya no
 * existe (venció: el reconciliador pudo haber reasignado el trabajo).
 */
export async function renovarArriendos(
  redis: Pick<ClienteRedis, "pexpire" | "zadd" | "get">,
  k: ClavesCola,
  t: Arrendable,
  ahoraMs: number,
): Promise<boolean> {
  const vivo = (await redis.pexpire(k.ejec(t.id), ARRIENDO_MS)) === 1;
  const vence = ahoraMs + ARRIENDO_MS;
  await redis.zadd(k.cupoTenant(t.cola, t.tenantId), "XX", vence, t.id);
  await redis.zadd(k.cupoGlobal(t.cola), "XX", vence, t.id);
  if (conLock(t)) {
    const clave = k.lockRuc(t.canal, t.ruc);
    if ((await redis.get(clave)) === t.id)
      await redis.pexpire(clave, ARRIENDO_MS);
  }
  return vivo;
}

/** Al terminar: libera los cupos y el arriendo del ejecutor y deja el lock con PX = espera_ruc_ms. */
export async function liberarArriendos(
  redis: Pick<ClienteRedis, "zrem" | "get" | "set" | "del">,
  k: ClavesCola,
  t: Arrendable,
  esperaRucMs: number,
): Promise<void> {
  await redis.zrem(k.cupoTenant(t.cola, t.tenantId), t.id);
  await redis.zrem(k.cupoGlobal(t.cola), t.id);
  await soltarLockRuc(redis, k, t, esperaRucMs);
  if ((await redis.get(k.ejec(t.id))) === t.id) await redis.del(k.ejec(t.id));
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

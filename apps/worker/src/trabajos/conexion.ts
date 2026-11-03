// Opciones de conexión de BullMQ a partir de REDIS_URL (spec 008). La URL y sus credenciales nunca se registran.
import type { ConexionBull } from "@contapp/queue/worker";

export class RedisUrlInvalidaError extends Error {
  readonly codigo = "redis_url_invalida";
  constructor() {
    super("REDIS_URL ausente o inválida");
    this.name = "RedisUrlInvalidaError";
  }
}

/** `redis://[usuario:clave@]host[:puerto][/base]` → { host, port, db, username?, password? }. */
export function conexionDesdeUrl(url: string | undefined): ConexionBull {
  let u: URL;
  try {
    u = new URL(String(url));
  } catch {
    throw new RedisUrlInvalidaError();
  }
  if (
    (u.protocol !== "redis:" && u.protocol !== "rediss:") ||
    u.hostname === ""
  )
    throw new RedisUrlInvalidaError();
  const base = u.pathname.replace(/^\//, "");
  if (base !== "" && !/^\d{1,2}$/.test(base)) throw new RedisUrlInvalidaError();
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    db: base === "" ? 0 : Number(base),
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    ...(u.protocol === "rediss:" ? { tls: {} } : {}),
  };
}

// Renovación del token SIRE tras un 401 (spec 041, H-041-2-8): la caché solo se borra si guarda el token rechazado; si otro uso
// ya la renovó se usa ese sin pedir otro; si la caché está vacía se pide uno nuevo. Redis en memoria, sin BD.
import type { SireAuth } from "@contapp/sunat";
import { describe, expect, it, vi } from "vitest";
import { CacheTokenSire, TokenRechazadoError } from "./cache-token.js";

function redisMemoria() {
  const m = new Map<string, Buffer>();
  return {
    m,
    getBuffer: vi.fn(async (k: string) => m.get(k) ?? null),
    set: vi.fn(async (k: string, v: Buffer) => {
      m.set(k, v);
      return "OK" as const;
    }),
    del: vi.fn(async (k: string) => Number(m.delete(k))),
  };
}
const ctx = { tenantId: "t", clienteId: "c", ruc: "20100070970" };
const cred = async () => ({
  clientId: "i",
  clientSecret: "s",
  usuarioSol: "u",
  claveSol: "k",
  ruc: ctx.ruc,
});

/** SireAuth que entrega T1, T2, ... (con retardo opcional para que las peticiones se solapen). */
function authNumerado(retardoMs = 0) {
  let n = 0;
  const obtenerToken = vi.fn(async () => {
    n += 1;
    if (retardoMs > 0) await new Promise((r) => setTimeout(r, retardoMs));
    return { token: `T${n}`, expiraEn: new Date(Date.now() + 600_000) };
  });
  return { obtenerToken } satisfies SireAuth;
}

function crear(retardoMs = 0) {
  const redis = redisMemoria();
  const auth = authNumerado(retardoMs);
  const cache = new CacheTokenSire({
    redis: redis as never,
    sireAuth: auth,
    credenciales: cred,
  });
  return { redis, auth, cache };
}

describe("CacheTokenSire.conToken: renovación tras token rechazado (H-041-2-8)", () => {
  it("dos usos con el mismo token rechazado piden UN solo token nuevo y ambos terminan con él", async () => {
    const { auth, cache } = crear(10);
    const usados: string[] = [];
    const usar = async (token: string) => {
      usados.push(token);
      if (token === "T1") throw new TokenRechazadoError();
      return `ok-${token}`;
    };
    const [a, b] = await Promise.all([
      cache.conToken(ctx, usar),
      cache.conToken(ctx, usar),
    ]);
    expect([a, b]).toEqual(["ok-T2", "ok-T2"]);
    expect(auth.obtenerToken).toHaveBeenCalledTimes(2); // T1 y un único T2
    expect(usados.filter((t) => t === "T2")).toHaveLength(2);
  });

  it("si otro uso ya renovó la caché con un token distinto, usa ese sin pedir otro ni borrar nada", async () => {
    const { redis, auth, cache } = crear();
    const resultado = await cache.conToken(ctx, async (token) => {
      if (token !== "T1") return `ok-${token}`;
      // Otro uso del mismo cliente renueva mientras este recibe su 401: la caché pasa a guardar T2.
      redis.m.clear();
      expect(await cache.obtener(ctx)).toBe("T2");
      throw new TokenRechazadoError();
    });
    expect(resultado).toBe("ok-T2");
    expect(auth.obtenerToken).toHaveBeenCalledTimes(2);
    expect(redis.del).not.toHaveBeenCalled();
    expect(redis.m.size).toBe(1); // la caché sigue guardando T2
  });

  it("si la caché ya está vacía (expiró o se evictó), pide un token nuevo sin borrar nada", async () => {
    const { redis, auth, cache } = crear();
    const resultado = await cache.conToken(ctx, async (token) => {
      if (token === "T1") {
        redis.m.clear();
        throw new TokenRechazadoError();
      }
      return `ok-${token}`;
    });
    expect(resultado).toBe("ok-T2");
    expect(auth.obtenerToken).toHaveBeenCalledTimes(2);
    expect(redis.del).not.toHaveBeenCalled();
    expect(await cache.obtener(ctx)).toBe("T2"); // el nuevo quedó en caché
    expect(auth.obtenerToken).toHaveBeenCalledTimes(2);
  });

  it("si una lectura en vuelo devuelve el mismo token rechazado, igual lo borra y pide uno nuevo", async () => {
    const { redis, auth, cache } = crear();
    let lecturaEnVuelo: Promise<string> | undefined;
    const resultado = await cache.conToken(ctx, async (token) => {
      if (token === "T1") {
        // Una lectura concurrente de la caché sigue en vuelo cuando llega el 401: devolverá T1, el rechazado.
        lecturaEnVuelo = cache.obtener(ctx);
        throw new TokenRechazadoError();
      }
      return `ok-${token}`;
    });
    expect(await lecturaEnVuelo).toBe("T1");
    expect(resultado).toBe("ok-T2");
    expect(redis.del).toHaveBeenCalledTimes(1);
    expect(auth.obtenerToken).toHaveBeenCalledTimes(2);
  });
});

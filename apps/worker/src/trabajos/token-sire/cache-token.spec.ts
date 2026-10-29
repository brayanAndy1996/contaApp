// Unitarias de CacheTokenSire (T10, CA-11): ramas que la integración no alcanza (vigencia menor que el margen, id de
// proceso por defecto, error distinto de 401 en el segundo uso). Redis en memoria.
import { ErrorTransitorio, type SireAuth } from "@contapp/sunat";
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

describe("CacheTokenSire (unitarias)", () => {
  it("caso feliz: guarda el token cifrado con un id de proceso aleatorio por defecto", async () => {
    const redis = redisMemoria();
    const auth: SireAuth = {
      obtenerToken: vi.fn(async () => ({
        token: "T1",
        expiraEn: new Date(Date.now() + 600_000),
      })),
    };
    const c = new CacheTokenSire({
      redis: redis as never,
      sireAuth: auth,
      credenciales: cred,
    });
    expect(await c.obtener(ctx)).toBe("T1");
    const [clave] = [...redis.m.keys()];
    expect(clave).toMatch(/^contapp:sire:token:[0-9a-f-]{36}:t:c$/);
    expect(redis.m.get(clave!)!.toString("latin1")).not.toContain("T1");
  });

  it("un token que vence antes del margen no se guarda (se pide otra vez)", async () => {
    const redis = redisMemoria();
    const obtenerToken = vi.fn(async () => ({
      token: "corto",
      expiraEn: new Date(Date.now() + 1_000),
    }));
    const c = new CacheTokenSire({
      redis: redis as never,
      sireAuth: { obtenerToken },
      credenciales: cred,
      proceso: "p",
    });
    await c.obtener(ctx);
    await c.obtener(ctx);
    expect(redis.set).not.toHaveBeenCalled();
    expect(obtenerToken).toHaveBeenCalledTimes(2);
  });

  it("error: tras un 401, un error distinto en el segundo uso se propaga tal cual", async () => {
    const redis = redisMemoria();
    const auth: SireAuth = {
      obtenerToken: vi.fn(async () => ({
        token: "T",
        expiraEn: new Date(Date.now() + 600_000),
      })),
    };
    const c = new CacheTokenSire({
      redis: redis as never,
      sireAuth: auth,
      credenciales: cred,
      proceso: "p",
    });
    let usos = 0;
    await expect(
      c.conToken(ctx, async () => {
        usos += 1;
        throw usos === 1 ? new TokenRechazadoError() : new ErrorTransitorio();
      }),
    ).rejects.toBeInstanceOf(ErrorTransitorio);
    expect(redis.del).toHaveBeenCalledTimes(1);
    expect(new TokenRechazadoError().codigo).toBe("token_rechazado");
  });
});

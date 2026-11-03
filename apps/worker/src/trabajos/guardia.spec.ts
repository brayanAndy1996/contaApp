// Unitarias de la guardia de muerte del proceso (T10, CA-10): tras `abortar` nada llega a la BD ni a Redis.
import { describe, expect, it, vi } from "vitest";
import { dbGuardada, ProcesoDetenidoError, redisGuardado } from "./guardia.js";

describe("redisGuardado", () => {
  it("vivo: reenvía el comando; muerto: lo rechaza sin emitirlo", async () => {
    let muerto = false;
    const get = vi.fn(async () => "v");
    const r = redisGuardado({ get, status: "ready" } as never, () => muerto);
    expect(await r.get("k")).toBe("v");
    expect((r as unknown as { status: string }).status).toBe("ready");
    muerto = true;
    await expect(r.get("k")).rejects.toBeInstanceOf(ProcesoDetenidoError);
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe("dbGuardada", () => {
  it("vivo: abre la transacción y consulta; muerto: no abre ni consulta (la abierta recibe un rechazo)", async () => {
    let muerto = false;
    const query = vi.fn(async (...a: unknown[]) => ({ rows: a }));
    const tx = { query, otro: 1 };
    const withTenant = vi.fn(
      async (_c: unknown, fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    );
    const withSistema = vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) =>
      fn(tx),
    );
    const db = dbGuardada(
      { withTenant, withSistema, pool: "p" } as never,
      () => muerto,
    ) as unknown as {
      withTenant: typeof withTenant;
      withSistema: typeof withSistema;
      pool: string;
    };
    expect(db.pool).toBe("p");
    await db.withTenant({ tenantId: "t" }, async (t) => {
      expect(t.otro).toBe(1);
      await t.query("select 1");
      muerto = true;
      await expect(t.query("select 2")).rejects.toThrow(ProcesoDetenidoError);
    });
    expect(query).toHaveBeenCalledTimes(1);
    await expect(db.withSistema(async () => 1)).rejects.toThrow(
      "El proceso de trabajos se detuvo",
    );
    expect(withSistema).not.toHaveBeenCalled();
  });
});

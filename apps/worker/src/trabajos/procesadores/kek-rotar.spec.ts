// Unitarias de kek.rotar (T10, CA-12): estudios en secuencia, lote opcional y conteos (rotación de 003 doble).
import { describe, expect, it, vi } from "vitest";

const llamadas = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("../../credenciales/rotar-kek.js", () => ({
  rotarKekTenantDetalle: vi.fn(async (o: Record<string, unknown>) => {
    llamadas.push(o);
    return {
      reenvueltas: 2,
      omitidas: 1,
      corruptas: o.tenantId === "b" ? ["x"] : [],
    };
  }),
}));
vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  estudiosIds: vi.fn(async () => ["a", "b"]),
}));

import { kekRotar } from "./kek-rotar.js";

describe("kekRotar (unitarias)", () => {
  it("caso feliz: rota cada estudio con el lote pedido y suma los conteos; avisa si quedan corruptas", async () => {
    const warn = vi.fn();
    const db = {
      withSistema: async (fn: (tx: unknown) => unknown) => fn({}),
      withTenant: vi.fn(),
    };
    const r = await kekRotar({
      db: db as never,
      anterior: {} as never,
      activa: {} as never,
      desde: "k1",
      lote: 5,
      logger: { info: vi.fn(), warn, error: vi.fn() },
    });
    expect(r).toEqual({
      estudios: 2,
      reenvueltas: 4,
      omitidas: 2,
      corruptas: 1,
    });
    expect(llamadas.map((l) => [l.tenantId, l.lote])).toEqual([
      ["a", 5],
      ["b", 5],
    ]);
    expect(warn).toHaveBeenCalledWith({ evento: "kek_rotar_terminado", ...r });
  });

  it("error: si la enumeración falla no rota nada", async () => {
    llamadas.length = 0;
    const db = {
      withSistema: async () => Promise.reject(new Error("bd")),
      withTenant: vi.fn(),
    };
    await expect(
      kekRotar({
        db: db as never,
        anterior: {} as never,
        activa: {} as never,
        desde: "k1",
      }),
    ).rejects.toThrow("bd");
    expect(llamadas).toHaveLength(0);
  });
});

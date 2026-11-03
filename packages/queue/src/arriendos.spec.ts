import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ARRIENDO_MS,
  crearClaves,
  iniciarLatido,
  liberarArriendos,
  renovarArriendos,
  soltarLockRuc,
  tomarCupos,
  tomarEjecucion,
  tomarLockRuc,
} from "./index.js";
import { uuidDe } from "./soporte-pruebas/bd-falsa.js";
import { RedisFalso } from "./soporte-pruebas/redis-falso.js";
import { RelojFalso } from "./soporte-pruebas/reloj-falso.js";

// T9 (backend): arriendos que usa el ejecutor del worker (D5, D20, CA-10). Contrato en arriendos.ts:
// tomarEjecucion (SET NX PX 30 s), renovarArriendos (latido: ejec, cupos y lock otros 30 s; false si
// el arriendo del ejecutor ya vencio), liberarArriendos (cupos fuera, ejec fuera, lock con PX =
// espera_ruc_ms solo si es propio), iniciarLatido (setInterval cancelable).
const k = crearClaves("t:");
const T = {
  id: uuidDe(1),
  tenantId: uuidDe(0xa1),
  cola: "sire",
  canal: "sire",
  ruc: "20100000001",
};
let reloj: RelojFalso;
let redis: RedisFalso;

beforeEach(() => {
  reloj = new RelojFalso();
  redis = new RedisFalso(reloj);
});
afterEach(() => vi.useRealTimers());

describe("arriendo del ejecutor", () => {
  it("un solo ejecutor por jobId mientras el arriendo vive", async () => {
    expect(await tomarEjecucion(redis as never, k, T.id)).toBe(true);
    expect(await tomarEjecucion(redis as never, k, T.id)).toBe(false);
    reloj.avanzar(ARRIENDO_MS);
    expect(await tomarEjecucion(redis as never, k, T.id)).toBe(true);
  });
});

describe("renovarArriendos (latido)", () => {
  it("extiende ejec, cupos y lock otros 30 s", async () => {
    await tomarEjecucion(redis as never, k, T.id);
    await tomarCupos(redis as never, k, T, reloj.ms());
    await tomarLockRuc(redis as never, k, T);
    reloj.avanzar(10_000);
    expect(await renovarArriendos(redis as never, k, T, reloj.ms())).toBe(true);
    reloj.avanzar(25_000); // 35 s desde la toma: sin latido ya habria vencido
    expect(await redis.exists(k.ejec(T.id))).toBe(1);
    expect(await redis.exists(k.lockRuc("sire", T.ruc))).toBe(1);
    expect(Number(await redis.zscore(k.cupoGlobal("sire"), T.id))).toBe(
      reloj.ms() - 25_000 + ARRIENDO_MS,
    );
  });

  it("devuelve false si el arriendo del ejecutor ya vencio y no toca un lock ajeno", async () => {
    await redis.set(k.lockRuc("sire", T.ruc), "otro", "PX", 1000);
    expect(await renovarArriendos(redis as never, k, T, reloj.ms())).toBe(
      false,
    );
    expect(await redis.pttl(k.lockRuc("sire", T.ruc))).toBe(1000);
  });

  it("canal ninguno no toca locks", async () => {
    const sinCanal = { ...T, canal: "ninguno" };
    expect(await tomarLockRuc(redis as never, k, sinCanal)).toBe(true);
    await renovarArriendos(redis as never, k, sinCanal, reloj.ms());
    await soltarLockRuc(redis as never, k, sinCanal, 0);
    expect(redis.claves().some((c) => c.includes("lock"))).toBe(false);
  });
});

describe("liberarArriendos", () => {
  it("libera cupos y ejec y deja el lock con PX = espera_ruc_ms (D20)", async () => {
    await tomarEjecucion(redis as never, k, T.id);
    await tomarCupos(redis as never, k, T, reloj.ms());
    await tomarLockRuc(redis as never, k, T);
    await liberarArriendos(redis as never, k, T, 2000);
    expect(await redis.zcard(k.cupoGlobal("sire"))).toBe(0);
    expect(await redis.zcard(k.cupoTenant("sire", T.tenantId))).toBe(0);
    expect(await redis.exists(k.ejec(T.id))).toBe(0);
    expect(await redis.pttl(k.lockRuc("sire", T.ruc))).toBe(2000);
  });

  it("con espera 0 borra el lock propio y nunca uno ajeno", async () => {
    await tomarLockRuc(redis as never, k, T);
    await liberarArriendos(redis as never, k, T, 0);
    expect(await redis.exists(k.lockRuc("sire", T.ruc))).toBe(0);
    await redis.set(k.lockRuc("sire", T.ruc), "otro", "PX", 5000);
    await redis.set(k.ejec(T.id), "otro");
    await liberarArriendos(redis as never, k, T, 0);
    expect(await redis.get(k.lockRuc("sire", T.ruc))).toBe("otro");
    expect(await redis.get(k.ejec(T.id))).toBe("otro");
  });
});

describe("iniciarLatido", () => {
  it("llama a renovar cada intervalo hasta detenerlo e ignora sus errores", async () => {
    vi.useFakeTimers();
    let n = 0;
    const parar = iniciarLatido(async () => {
      n++;
      if (n === 2) throw new Error("redis caido");
    }, 100);
    await vi.advanceTimersByTimeAsync(350);
    expect(n).toBe(3);
    parar();
    await vi.advanceTimersByTimeAsync(500);
    expect(n).toBe(3);
  });

  it("usa 10 s por defecto", async () => {
    vi.useFakeTimers();
    let n = 0;
    const parar = iniciarLatido(async () => {
      n++;
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(n).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(n).toBe(1);
    parar();
  });
});

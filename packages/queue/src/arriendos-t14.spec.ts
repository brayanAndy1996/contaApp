// T14 (backend, correcciones de la ronda adversarial 1): reserva atómica de cupos (H-008-1b-1), hora de Redis y poda
// que respeta `ejec:` (H-008-1b-2) y dueño por ejecución en renovar/soltar/liberar (H-008-1b-3). RedisFalso con el
// mismo reloj que gobierna sus vencimientos.
import { beforeEach, describe, expect, it } from "vitest";
import {
  ARRIENDO_MS,
  crearClaves,
  cuposVivos,
  horaRedisMs,
  liberarArriendos,
  renovarArriendos,
  reservarCupos,
  soltarLockRuc,
  tomarCupos,
  tomarEjecucion,
  tomarLockRuc,
} from "./index.js";
import { uuidDe } from "./soporte-pruebas/bd-falsa.js";
import { RedisFalso } from "./soporte-pruebas/redis-falso.js";
import { RelojFalso } from "./soporte-pruebas/reloj-falso.js";

const k = crearClaves("t14:");
const T = uuidDe(0xa1);
const trabajo = (n: number) => ({
  id: uuidDe(n),
  tenantId: T,
  cola: "sire",
  canal: "sire",
  ruc: `2010000000${n % 10}`,
});
const limites = { global: 3, tenant: 2 };
let reloj: RelojFalso;
let redis: RedisFalso;

beforeEach(() => {
  reloj = new RelojFalso();
  redis = new RedisFalso(reloj);
});

describe("horaRedisMs", () => {
  it("convierte TIME (segundos, microsegundos) a ms", async () => {
    expect(
      await horaRedisMs({ time: async () => ["12", "345678"] } as never),
    ).toBe(12_345);
  });

  it("propaga el fallo de Redis", async () => {
    redis.fallar(new Error("caído"));
    await expect(horaRedisMs(redis as never)).rejects.toThrow("caído");
  });
});

describe("reservarCupos (H-008-1b-1)", () => {
  it("reserva hasta el límite del estudio y deshace la que lo pasa", async () => {
    expect(
      await reservarCupos(redis as never, k, trabajo(1), reloj.ms(), limites),
    ).toBe(true);
    expect(
      await reservarCupos(redis as never, k, trabajo(2), reloj.ms(), limites),
    ).toBe(true);
    expect(
      await reservarCupos(redis as never, k, trabajo(3), reloj.ms(), limites),
    ).toBe("tenant");
    expect(
      await redis.zscore(k.cupoTenant("sire", T), trabajo(3).id),
    ).toBeNull();
    expect(await redis.zscore(k.cupoGlobal("sire"), trabajo(3).id)).toBeNull();
    expect(
      Number(await redis.zscore(k.cupoGlobal("sire"), trabajo(1).id)),
    ).toBe(reloj.ms() + ARRIENDO_MS);
  });

  it("el cupo global lleno (por otro estudio) responde 'global' y no deja nada", async () => {
    for (const n of [7, 8, 9])
      await redis.zadd(
        k.cupoGlobal("sire"),
        reloj.ms() + ARRIENDO_MS,
        uuidDe(n),
      );
    expect(
      await reservarCupos(redis as never, k, trabajo(1), reloj.ms(), limites),
    ).toBe("global");
    expect(await redis.zcard(k.cupoTenant("sire", T))).toBe(0);
    expect(await redis.zcard(k.cupoGlobal("sire"))).toBe(3);
  });
});

describe("poda de cupos (H-008-1b-2)", () => {
  it("un cupo vencido según el reloj de quien poda sigue vivo mientras su ejec: exista; sin ejec se quita", async () => {
    const vivo = trabajo(1);
    const muerto = trabajo(2);
    await tomarCupos(redis as never, k, vivo, reloj.ms());
    await tomarCupos(redis as never, k, muerto, reloj.ms());
    await redis.set(k.ejec(vivo.id), "e", "PX", 10 * ARRIENDO_MS);
    // Un proceso con el reloj 40 s adelantado.
    expect(
      await cuposVivos(
        redis as never,
        k,
        k.cupoTenant("sire", T),
        reloj.ms() + 40_000,
      ),
    ).toBe(1);
    expect(await redis.zscore(k.cupoTenant("sire", T), vivo.id)).not.toBeNull();
    expect(await redis.zscore(k.cupoTenant("sire", T), muerto.id)).toBeNull();
  });

  it("un escritor con el reloj atrasado vence con la hora de Redis", async () => {
    await tomarCupos(redis as never, k, trabajo(1), reloj.ms() - 40_000);
    expect(
      Number(await redis.zscore(k.cupoGlobal("sire"), trabajo(1).id)),
    ).toBe(reloj.ms() + ARRIENDO_MS);
  });
});

describe("dueño por ejecución (H-008-1b-3)", () => {
  it("la ejecución dueña renueva, acorta el lock y libera todo", async () => {
    const t = { ...trabajo(1), ejecucion: "e1" };
    expect(await tomarEjecucion(redis as never, k, t.id, "e1")).toBe(true);
    await tomarCupos(redis as never, k, t, reloj.ms());
    await tomarLockRuc(redis as never, k, t);
    reloj.avanzar(10_000);
    expect(await renovarArriendos(redis as never, k, t, reloj.ms())).toBe(true);
    await soltarLockRuc(redis as never, k, t, 500);
    expect(await redis.pttl(k.lockRuc("sire", t.ruc))).toBe(500);
    await liberarArriendos(redis as never, k, t, 500);
    expect(await redis.exists(k.ejec(t.id))).toBe(0);
    expect(await redis.zcard(k.cupoGlobal("sire"))).toBe(0);
  });

  it("una ejecución vieja no renueva, no acorta el lock ni libera lo de la nueva", async () => {
    const vieja = { ...trabajo(1), ejecucion: "e1" };
    const nueva = { ...vieja, ejecucion: "e2" };
    await tomarEjecucion(redis as never, k, nueva.id, "e2");
    await tomarCupos(redis as never, k, nueva, reloj.ms());
    await tomarLockRuc(redis as never, k, nueva);
    expect(await renovarArriendos(redis as never, k, vieja, reloj.ms())).toBe(
      false,
    );
    await soltarLockRuc(redis as never, k, vieja, 500);
    await liberarArriendos(redis as never, k, vieja, 500);
    expect(await redis.get(k.ejec(nueva.id))).toBe("e2");
    expect(await redis.pttl(k.lockRuc("sire", nueva.ruc))).toBe(ARRIENDO_MS);
    expect(await redis.zscore(k.cupoGlobal("sire"), nueva.id)).not.toBeNull();
  });
});

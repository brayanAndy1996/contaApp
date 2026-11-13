// Spec 022 · T2 (RP-1, CA-2, CA-4, CA-5): lectura acotada de la lista de pistas del despachador.
// PostgreSQL y Redis reales (base 15, prefijo propio). Los restos son ids sin trabajo `en_cola` en BD.
import { randomUUID } from "node:crypto";
import type { ContappDb } from "@contapp/db";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { crearClaves } from "./claves.js";
import { Despachador, TRAMO_PISTAS } from "./despachador.js";
import {
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  Escenario,
  limpiarPrefijo,
} from "./soporte-pruebas/int.js";
import { BAJO_COBERTURA, medirMediana } from "./soporte-pruebas/tiempos.js";

// Cuenta las llamadas a `leerTrabajo` (D-2); el resto de @contapp/db es el real.
const cuenta = vi.hoisted(() => ({ leerTrabajo: 0 }));
vi.mock("@contapp/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@contapp/db")>();
  return {
    ...real,
    leerTrabajo: (...a: Parameters<typeof real.leerTrabajo>) => {
      cuenta.leerTrabajo++;
      return real.leerTrabajo(...a);
    },
  };
});

const prefijo = `t022-q-${randomUUID().slice(0, 8)}:`;
const k = crearClaves(prefijo);
let admin: ContappDb;
let worker: ContappDb;
let redis: Redis;
let e: Escenario;

beforeAll(async () => {
  admin = crearDbAdmin();
  worker = crearDbRol("contapp_worker", 6);
  redis = conectarRedis();
  e = new Escenario(admin);
}, 30_000);

afterAll(async () => {
  await e?.limpiar();
  await limpiarPrefijo(redis, prefijo).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([worker?.close(), admin?.close()]);
});

interface Comandos {
  /** Un registro por `zrange` sobre la lista del estudio: rango pedido y cantidad devuelta. */
  zrange: { inicio: string; fin: string; devueltos: number }[];
  /** Cantidad de ids de cada `zrem` sobre la lista del estudio. */
  zrem: number[];
  zcard: number;
}

/** Redis que cuenta, por nombre y argumentos, los comandos sobre la lista de pistas del estudio. */
function redisContado(pend: string): { redis: Redis; c: Comandos } {
  const c: Comandos = { zrange: [], zrem: [], zcard: 0 };
  const proxy = new Proxy(redis, {
    get(t, p, rcv) {
      const v = Reflect.get(t, p, rcv);
      if (typeof v !== "function") return v;
      return async (...a: unknown[]) => {
        const r = await (v as (...x: unknown[]) => Promise<unknown>).apply(
          t,
          a,
        );
        if (a[0] === pend) {
          if (p === "zrange")
            c.zrange.push({
              inicio: String(a[1]),
              fin: String(a[2]),
              devueltos: (r as string[]).length,
            });
          if (p === "zrem") c.zrem.push(a.length - 1);
          if (p === "zcard") c.zcard++;
        }
        return r;
      };
    },
  }) as Redis;
  return { redis: proxy, c };
}

/** Estudio sin trabajos en BD con N restos en su lista de pistas y anotado en `tenants`. */
async function estudioConRestos(n: number): Promise<string> {
  const T = await e.estudio();
  await redis.del(k.tenants("sire"));
  await redis.del(k.lider("sire"));
  await sembrar(T, n);
  return T;
}

async function sembrar(T: string, n: number): Promise<void> {
  const pend = k.pend("sire", T);
  await redis.del(pend);
  for (let i = 0; i < n; i += 5000) {
    const args: (string | number)[] = [];
    for (let j = i; j < Math.min(n, i + 5000); j++)
      args.push(j + 1, randomUUID());
    await redis.zadd(pend, ...args);
  }
  await redis.sadd(k.tenants("sire"), T);
}

const despachador = (rd: Redis): Despachador =>
  new Despachador({
    db: worker,
    redis: rd,
    reloj: { ahora: () => new Date() },
    prefijo,
    agregarACola: async () => undefined,
  });

describe("RP-1: una atención lee y borra como máximo un tramo de la lista", () => {
  it("el tramo es 100, independiente de la ventana de candidatos", () => {
    expect(TRAMO_PISTAS).toBe(100);
  });

  it.each([2_000, 20_000])(
    "CA-2: con N = %i restos, una atención lee ≤ K ids, borra ≤ K y hace ≤ K leerTrabajo",
    async (n) => {
      const T = await estudioConRestos(n);
      const pend = k.pend("sire", T);
      const { redis: rd, c } = redisContado(pend);
      cuenta.leerTrabajo = 0;
      await despachador(rd).ciclo();

      expect(c.zrange.length).toBeGreaterThan(0);
      for (const z of c.zrange) {
        expect(z.fin, "ningún zrange 0 -1").not.toBe("-1");
        expect(z.devueltos).toBeLessThanOrEqual(TRAMO_PISTAS);
      }
      expect(c.zrem.length).toBeGreaterThan(0);
      for (const q of c.zrem) expect(q).toBeLessThanOrEqual(TRAMO_PISTAS);
      expect(cuenta.leerTrabajo).toBeLessThanOrEqual(TRAMO_PISTAS);
      // El resto de la lista sigue ahí y el estudio se repone para el siguiente ciclo (G3).
      expect(await redis.zcard(pend)).toBe(n - TRAMO_PISTAS);
      expect(await redis.sismember(k.tenants("sire"), T)).toBe(1);
    },
    60_000,
  );

  it("CA-4: N = 20.000 restos quedan en lista vacía y estudio fuera de tenants en ≤ ⌈N/K⌉ + 1 ciclos, sin bucle posterior", async () => {
    const n = 20_000;
    const T = await estudioConRestos(n);
    const pend = k.pend("sire", T);
    const { redis: rd, c } = redisContado(pend);
    const d = despachador(rd);
    const tope = Math.ceil(n / TRAMO_PISTAS) + 1;
    let ciclos = 0;
    let antes = n;
    while ((await redis.sismember(k.tenants("sire"), T)) === 1) {
      expect(++ciclos, "no converge").toBeLessThanOrEqual(tope);
      await d.ciclo();
      const ahora = await redis.zcard(pend);
      expect(antes - ahora, "cada cierre quita ≤ K ids").toBeLessThanOrEqual(
        TRAMO_PISTAS,
      );
      antes = ahora;
    }
    expect(await redis.zcard(pend)).toBe(0);
    expect(ciclos).toBeLessThanOrEqual(tope);
    for (const z of c.zrange)
      expect(z.devueltos).toBeLessThanOrEqual(TRAMO_PISTAS);

    // G4: sin bucle posterior. El estudio ya no está en tenants, así que otro ciclo no vuelve a tocar su lista.
    const antesZ = c.zrange.length;
    await d.ciclo();
    await d.ciclo();
    expect(c.zrange.length).toBe(antesZ);
    expect(await redis.sismember(k.tenants("sire"), T)).toBe(0);
  }, 120_000);

  it("CA-5: mediana de 5 atenciones con N = 20.000 ≤ 100 ms y ≤ 1,5 × la de N = 100 (Redis real, sin instrumentar)", async () => {
    const T100 = await estudioConRestos(100);
    const T20k = await e.estudio();
    const d = despachador(redis);
    const muestra = (T: string, n: number) => async () => {
      // Cada muestra parte de la lista completa; solo se cronometra la atención del estudio.
      await redis.del(k.tenants("sire"), k.lider("sire"));
      await sembrar(T, n);
      const t0 = performance.now();
      await d.ciclo();
      return performance.now() - t0;
    };
    await muestra(T100, 100)(); // calentamiento (conexiones, caché de configuración)
    const base = await medirMediana(muestra(T100, 100), 5);
    const grande = await medirMediana(muestra(T20k, 20_000), 5);
    console.log(
      `CA-5 RP-1: N=100 ${base.toFixed(1)} ms · N=20.000 ${grande.toFixed(1)} ms · razón ${(grande / base).toFixed(2)}${BAJO_COBERTURA ? " (bajo cobertura: no se compara)" : ""}`,
    );
    if (BAJO_COBERTURA) return;
    expect(grande).toBeLessThanOrEqual(100);
    expect(grande).toBeLessThanOrEqual(1.5 * base);
  }, 120_000);
});

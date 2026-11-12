// Spec 018 · T11c: carrera entre el cierre de un estudio «vacío» y la publicación de un trabajo nuevo.
// PostgreSQL y Redis reales (base 15, prefijo propio).
//
// Defecto (visto por T11b en E2E): cuando la ventana del estudio sale vacía y no quedan `en_cola`, el despachador
// quita al estudio de `tenants:{cola}` y borra `pend:{cola}:{tenant}` DESPUÉS del commit. Si entre la lectura en BD y
// ese borrado el backend publica un trabajo nuevo (ZADD pend + SADD tenants), el borrado se lo lleva y el trabajo queda
// invisible hasta que el reconciliador lo repone (30-60 s).
//
// Las pruebas fijan la carrera de forma determinista: un Redis-proxy publica el trabajo nuevo justo antes del primer
// comando de borrado del despachador (o entre su SREM y su verificación).
import { randomUUID } from "node:crypto";
import type { ContappDb } from "@contapp/db";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crearClaves } from "./claves.js";
import { Despachador } from "./despachador.js";
import {
  anunciar,
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  Escenario,
  limpiarPrefijo,
} from "./soporte-pruebas/int.js";
import type { PayloadTrabajo } from "./tipos.js";

const prefijo = `t11c-q-${randomUUID().slice(0, 8)}:`;
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

const anotar =
  (lista: PayloadTrabajo[]) => async (_cola: string, p: PayloadTrabajo) => {
    lista.push(p);
  };

/**
 * Redis que, justo ANTES de que el despachador ejecute `comando` (la primera vez), deja correr `intruso()`:
 * el backend publicando un trabajo nuevo del mismo estudio en ese instante.
 */
function redisConIntruso(
  comando: string,
  intruso: () => Promise<void>,
  clave?: string,
): { redis: Redis; disparado: () => boolean } {
  let hecho = false;
  const proxy = new Proxy(redis, {
    get(t, p, rcv) {
      if (p === comando)
        return async (...a: unknown[]) => {
          if (!hecho && (clave === undefined || a[0] === clave)) {
            hecho = true;
            await intruso();
          }
          return (t[p as "get"] as (...x: unknown[]) => Promise<unknown>).apply(
            t,
            a,
          );
        };
      const v = Reflect.get(t, p, rcv);
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as Redis;
  return { redis: proxy, disparado: () => hecho };
}

/** Estudio sin pendientes en BD y con su pista en Redis (como queda tras despachar el último trabajo). */
async function estudioVacio(): Promise<string> {
  const T = await e.estudio();
  await redis.del(k.tenants("sire")); // los estudios de las otras pruebas no intervienen
  await redis.sadd(k.tenants("sire"), T);
  await redis.del(k.lider("sire"));
  return T;
}

describe("T11c: cierre de un estudio vacío vs. publicación concurrente", () => {
  it("un trabajo publicado entre la lectura en BD y el borrado de la pista no se pierde (antes del SREM)", async () => {
    const T = await estudioVacio();
    const c = await e.cliente(T);
    let nuevo = "";
    const { redis: rd, disparado } = redisConIntruso(
      "srem",
      async () => {
        // El backend inserta el trabajo y lo publica (ZADD pend, luego SADD tenants) después de la lectura vacía.
        [nuevo] = await e.trabajosEnMasa(T, c, 1);
        await anunciar(redis, prefijo, T, [nuevo]);
      },
      k.tenants("sire"),
    );
    const d = new Despachador({
      db: worker,
      redis: rd,
      reloj: { ahora: () => new Date() },
      prefijo,
      agregarACola: anotar([]),
    });
    await d.ciclo();
    expect(disparado()).toBe(true);
    expect(
      {
        estudioEnTenants: await redis.sismember(k.tenants("sire"), T),
        enPend: (await redis.zscore(k.pend("sire", T), nuevo)) !== null,
      },
      "el trabajo nuevo debe quedar visible para el próximo ciclo (sin esperar al reconciliador)",
    ).toEqual({ estudioEnTenants: 1, enPend: true });
  });

  it("lo mismo si la publicación cae entre el SREM y la comprobación de la lista (ZADD+SADD tras el SREM)", async () => {
    const T = await estudioVacio();
    const c = await e.cliente(T);
    let nuevo = "";
    const { redis: rd, disparado } = redisConIntruso(
      "zcard",
      async () => {
        [nuevo] = await e.trabajosEnMasa(T, c, 1);
        await anunciar(redis, prefijo, T, [nuevo]);
      },
      k.pend("sire", T),
    );
    const d = new Despachador({
      db: worker,
      redis: rd,
      reloj: { ahora: () => new Date() },
      prefijo,
      agregarACola: anotar([]),
    });
    await d.ciclo();
    expect(disparado()).toBe(true);
    expect(await redis.sismember(k.tenants("sire"), T)).toBe(1);
    expect(await redis.zscore(k.pend("sire", T), nuevo)).not.toBeNull();
  });

  it("un trabajo publicado antes de la lectura en BD se despacha en el mismo ciclo (control)", async () => {
    const T = await estudioVacio();
    const c = await e.cliente(T);
    const [id] = await e.trabajosEnMasa(T, c, 1);
    await anunciar(redis, prefijo, T, [id!]);
    const lista: PayloadTrabajo[] = [];
    const d = new Despachador({
      db: worker,
      redis,
      reloj: { ahora: () => new Date() },
      prefijo,
      agregarACola: anotar(lista),
    });
    await d.ciclo();
    expect(lista.map((p) => p.jobId)).toEqual([id]);
  });

  it("sin carrera, un estudio vacío sale de tenants y su lista (con restos de trabajos ya cancelados) se limpia", async () => {
    const T = await estudioVacio();
    // Restos: ids que ya no están en_cola (p. ej. cancelados desde el backend) siguen en la lista.
    await redis.zadd(k.pend("sire", T), 1, randomUUID(), 2, randomUUID());
    const d = new Despachador({
      db: worker,
      redis,
      reloj: { ahora: () => new Date() },
      prefijo,
      agregarACola: anotar([]),
    });
    await d.ciclo();
    expect(await redis.sismember(k.tenants("sire"), T)).toBe(0);
    expect(await redis.exists(k.pend("sire", T))).toBe(0);
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any -- resultados de Promise.allSettled sin tipo en pruebas */
import type { ContappDb } from "@contapp/db";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { crearClaves } from "./claves.js";
import { aPublicable, encolar, publicar } from "./encolado.js";
import {
  armar,
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  encolarYPublicar,
  Escenario,
  esperarHasta,
  fijarConfig,
  limpiarPrefijo,
  nuevoPrefijo,
  restaurarConfig,
  type ClientePrueba,
} from "./soporte-pruebas/int.js";

// Spec 008, T5 (integración con PostgreSQL y Redis reales): outbox y deduplicación (CA-1, D3, D8).
// Contrato que fija (ya implementado en T9): `encolar(tx, e)` solo escribe en BD dentro de la transacción del caso de uso;
// `publicar(redis, trabajos, { prefijo })` va después del commit y no propaga errores de Redis; el reconciliador repone
// `tenants:{cola}` de los `en_cola` sin cambios en ≥ 30 s (se envejecen con SQL, sin esperar). Sin Redis, el trabajo
// queda `en_cola` y la petición no falla. Redis: base 15 y prefijo propio.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const prefijo = nuevoPrefijo();
const k = crearClaves(prefijo);
let admin: ContappDb;
let backend: ContappDb;
let redis: Redis;
let e: Escenario;
let T: string;
let usuario: string;
let c1: ClientePrueba;

const entrada = (c: ClientePrueba, parametros: unknown = { n: 1 }) => ({
  tipo: "prueba.eco",
  clienteId: c.id,
  parametros,
  prioridad: "interactivo" as const,
  creadoPor: usuario,
});

beforeAll(async () => {
  admin = crearDbAdmin();
  backend = crearDbRol("contapp_backend");
  redis = conectarRedis();
  e = new Escenario(admin);
  T = await e.estudio();
  usuario = await e.usuario(T, "contador");
  c1 = await e.cliente(T);
  await e.asignar(T, c1.id, usuario);
  await fijarConfig(admin, "sire", { espera: 0 });
});

afterAll(async () => {
  await restaurarConfig(admin).catch(() => undefined);
  await e?.limpiar();
  await limpiarPrefijo(redis, prefijo).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([backend?.close(), admin?.close()]);
});

const filasDe = async (tipoParam: number) =>
  (await admin.pool.query("select id, estado from job_registro where tenant_id = $1 and parametros = $2::jsonb", [T, JSON.stringify({ n: tipoParam })])).rows;

describe("CA-1: encolar crea la fila en la transacción y publica después del commit", () => {
  it("con commit: la fila queda en_cola y, tras publicar, Redis tiene el estudio y el trabajo", async () => {
    const r = await encolarYPublicar(backend, redis, prefijo, T, entrada(c1, { n: 101 }));
    expect(r.nuevo).toBe(true);
    expect(r.trabajo).toMatchObject({ estado: "en_cola", intentos: 0, motivo: null, clienteId: c1.id });
    expect((await filasDe(101))).toHaveLength(1);
    expect(await redis.sismember(k.tenants("sire"), T)).toBe(1);
    expect(await redis.zscore(k.pend("sire", T), r.trabajo.id)).not.toBeNull();
  });

  it("transacción revertida: no queda fila y no hay nada en Redis (publicar nunca corre)", async () => {
    let id = "";
    await expect(
      backend.withTenant({ tenantId: T }, async (tx) => {
        id = (await encolar(tx, entrada(c1, { n: 102 }))).trabajo.id;
        throw new Error("el caso de uso falla después de encolar");
      }),
    ).rejects.toThrow("el caso de uso falla");
    expect(id).not.toBe("");
    expect(await filasDe(102)).toHaveLength(0);
    expect(await redis.zscore(k.pend("sire", T), id)).toBeNull();
  });

  it("Redis caído al encolar: la petición no falla, el trabajo queda en_cola y el reconciliador lo publica al volver", async () => {
    // Un cliente de Redis hacia un puerto cerrado: cada comando falla enseguida.
    const caido = new Redis({ host: "127.0.0.1", port: 1, lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null, enableOfflineQueue: false });
    caido.on("error", () => undefined);
    // Estudio propio: así este es el único trabajo vivo y el primer ciclo lo despacha.
    const T2 = await e.estudio();
    const u2 = await e.usuario(T2, "contador");
    const c2 = await e.cliente(T2);
    await e.asignar(T2, c2.id, u2);
    const r = await backend.withTenant({ tenantId: T2 }, (tx) => encolar(tx, { ...entrada(c2, { n: 103 }), creadoPor: u2 }));
    await expect(publicar(caido, [aPublicable(T2, r.trabajo, "interactivo")], { prefijo })).resolves.toBeUndefined();
    caido.disconnect();

    // Estado tras el fallo: 2xx (nada lanzó), fila en_cola y Redis real sin pista.
    const fila = (await admin.pool.query("select estado from job_registro where id = $1", [r.trabajo.id])).rows[0];
    expect(fila.estado).toBe("en_cola");
    expect(await redis.zscore(k.pend("sire", T2), r.trabajo.id)).toBeNull();
    expect(await redis.sismember(k.tenants("sire"), T2)).toBe(0);

    // Redis vuelve: el reconciliador ve el trabajo sin cambios en ≥ 30 s y repone la pista del estudio.
    await e.envejecer([r.trabajo.id]);
    const a = await armar({ prefijo, automatico: false, duracionMs: 10 });
    try {
      const resumen = await a.reconciliador.ciclo();
      expect(resumen.repuestos).toBeGreaterThanOrEqual(1);
      expect(await redis.sismember(k.tenants("sire"), T2)).toBe(1);
      // Con la pista repuesta el despachador lo despacha y se ejecuta de punta a punta.
      await a.despachador.ciclo();
      await esperarHasta(async () => (await e.fila(r.trabajo.id))?.estado === "completado", "trabajo completado tras reponer la pista");
    } finally {
      await a.detener();
    }
  });
});

describe("D8: deduplicación y concurrencia al encolar", () => {
  it("encolar 50 veces lo mismo deja una sola fila viva y todas las llamadas devuelven ese trabajo", async () => {
    const primero = await encolarYPublicar(backend, redis, prefijo, T, entrada(c1, { n: 201 }));
    expect(primero.nuevo).toBe(true);
    for (let i = 0; i < 49; i++) {
      const r = await encolarYPublicar(backend, redis, prefijo, T, entrada(c1, { n: 201 }));
      expect(r.nuevo).toBe(false);
      expect(r.trabajo.id).toBe(primero.trabajo.id);
    }
    expect(await filasDe(201)).toHaveLength(1);
  });

  it("parámetros distintos (o con las claves en otro orden) se distinguen bien: otro orden = mismo trabajo; otro valor = otro trabajo", async () => {
    const a = await encolarYPublicar(backend, redis, prefijo, T, entrada(c1, { n: 202, rango: "2026-01" }));
    const mismo = await encolarYPublicar(backend, redis, prefijo, T, entrada(c1, { rango: "2026-01", n: 202 }));
    const otro = await encolarYPublicar(backend, redis, prefijo, T, entrada(c1, { n: 202, rango: "2026-02" }));
    expect(mismo.trabajo.id).toBe(a.trabajo.id);
    expect(otro.trabajo.id).not.toBe(a.trabajo.id);
  });

  it("10 encolados simultáneos de lo mismo: nunca más de una fila viva (el perdedor recibe el trabajo existente o 23505, nunca otra fila)", async () => {
    const resultados = await Promise.allSettled(
      Array.from({ length: 10 }, () => backend.withTenant({ tenantId: T }, (tx) => encolar(tx, entrada(c1, { n: 203 })))),
    );
    expect(await filasDe(203)).toHaveLength(1);
    const ids = new Set(resultados.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<any>).value.trabajo.id));
    expect(ids.size).toBeLessThanOrEqual(1);
    for (const r of resultados.filter((x) => x.status === "rejected")) {
      expect((r as PromiseRejectedResult).reason?.codigo).toBe("23505");
    }
    expect(ids.size + resultados.filter((r) => r.status === "rejected").length).toBeGreaterThanOrEqual(1);
  });
});

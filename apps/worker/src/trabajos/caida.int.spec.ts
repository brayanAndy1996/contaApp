import type { ContappDb } from "@contapp/db";
import { crearClaves } from "@contapp/queue";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  arrancar,
  compuerta,
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  dormir,
  encolarYPublicar,
  Escenario,
  esperarHasta,
  fijarConfig,
  limpiarPrefijo,
  nuevoPrefijo,
  ProcesadorProgramable,
  registrarTiposDePrueba,
  restaurarConfig,
  type ProcesoWorker,
} from "../../test/trabajos.js";

// Spec 008, T5 (rojo; integración con PostgreSQL, Redis y BullMQ reales): el proceso del worker muere a mitad de los trabajos
// (CA-10, D5). Lee el contrato de `iniciarTrabajos`/`abortar` en ejecutor.int.spec.ts.
// Lo que fija (T10):
// - Mientras el trabajo corre, el ejecutor mantiene `ejec:{jobId}`, el cupo del estudio y el global y el lock del RUC con arriendos
//   de ≤ 30 s (PTTL ≤ 30 000), renovados por el latido; `abortar()` los deja tal cual (no libera nada) y no escribe más.
// - Otro proceso (misma BD y mismo Redis) los ve vencer solos: ≤ 60 s después el reconciliador resuelve cada `ejecutando` sin arriendo:
//   idempotente (`prueba.eco`) → `en_cola` con `intentos = 1` y se vuelve a despachar y completar; no idempotente
//   (`prueba.no_idempotente`) → `error`/`interrumpido`, sin reenviarse JAMÁS (el procesador nuevo no se invoca para él), aunque
//   BullMQ redelivere el payload de un job huérfano (stalled).
// - Al final los contadores no quedan desfasados: ZSET de cupos vacíos, sin `ejec:*` ni `lock:ruc:*` huérfanos.
// Es una prueba de tiempo real (~35 s): los arriendos y el reconciliador usan el reloj y el TTL de Redis reales. Las 10 caídas
// seguidas con tiempo simulado están en packages/queue/src/recuperacion.int.spec.ts.

vi.setConfig({ testTimeout: 150_000, hookTimeout: 60_000 });

registrarTiposDePrueba();

let admin: ContappDb;
let backend: ContappDb;
let redis: Redis;
let e: Escenario;
const prefijo = nuevoPrefijo();
const k = crearClaves(prefijo);
const procesos: ProcesoWorker[] = [];

beforeAll(async () => {
  admin = crearDbAdmin();
  backend = crearDbRol("contapp_backend");
  redis = conectarRedis();
  e = new Escenario(admin);
  await fijarConfig(admin, "sire", { global: 32, tenant: 16, espera: 0, reintentos: 3, base: 100 });
});

afterAll(async () => {
  await Promise.all(procesos.map((p) => p.detener({ esperaMs: 1000 }).catch(() => undefined)));
  await restaurarConfig(admin).catch(() => undefined);
  await e?.limpiar();
  await limpiarPrefijo(redis, prefijo).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([backend?.close(), admin?.close()]);
});

const todos = ["prueba.eco", "prueba.no_idempotente", "prueba.credencial_sol"] as const;
const mapa = (prog: ProcesadorProgramable) => Object.fromEntries(todos.map((t) => [t, prog.procesador]));

describe("CA-10: el proceso muere con 12 trabajos en curso", () => {
  it("cupo y lock se liberan solos en ≤ 60 s; el idempotente se reintenta, el no idempotente queda interrumpido y no se reenvía", async () => {
    const T = await e.estudio();
    const usuario = await e.usuario(T, "contador");
    const clientes = await Promise.all(Array.from({ length: 12 }, () => e.cliente(T)));
    for (const c of clientes) await e.asignar(T, c.id, usuario);

    // --- proceso 1: los procesadores se quedan colgados (el trabajo "está en curso" cuando muere) ---
    const colgado = new ProcesadorProgramable();
    const puerta = compuerta();
    colgado.comportamiento = async () => {
      await puerta.esperar();
      return { ok: true };
    };
    const p1 = await arrancar({ prefijo, procesadores: mapa(colgado) });
    procesos.push(p1);

    const idempotentes: string[] = [];
    const noIdempotentes: string[] = [];
    for (let i = 0; i < 12; i++) {
      const tipo = i < 6 ? "prueba.eco" : "prueba.no_idempotente";
      const id = (
        await encolarYPublicar(backend, redis, prefijo, T, { tipo, clienteId: clientes[i]!.id, parametros: { n: i + 1 }, creadoPor: usuario })
      ).trabajo.id;
      (i < 6 ? idempotentes : noIdempotentes).push(id);
    }
    const todosIds = [...idempotentes, ...noIdempotentes];
    await esperarHasta(() => colgado.llamadas.length === 12, "los 12 procesadores están en curso", { timeoutMs: 20_000 });

    // Arriendos vivos y acotados a 30 s.
    for (const [i, id] of todosIds.entries()) {
      const ttlEjec = await redis.pttl(k.ejec(id));
      expect(ttlEjec, `ejec de ${id}`).toBeGreaterThan(0);
      expect(ttlEjec).toBeLessThanOrEqual(30_000);
      expect(await redis.zscore(k.cupoTenant("sire", T), id), `cupo del estudio de ${id}`).not.toBeNull();
      expect(await redis.zscore(k.cupoGlobal("sire"), id)).not.toBeNull();
      const ttlLock = await redis.pttl(k.lockRuc("sire", clientes[i]!.ruc));
      expect(ttlLock, `lock del RUC de ${id}`).toBeGreaterThan(0);
      expect(ttlLock).toBeLessThanOrEqual(30_000);
    }

    // --- el proceso muere (kill -9) ---
    await p1.abortar();
    const muerteEn = Date.now();
    puerta.abrir(); // los procesadores abandonados "terminan" después de muerto el proceso: no debe haber ningún efecto
    await dormir(800);
    for (const id of todosIds) expect((await e.fila(id)).estado, "nada cambia tras la muerte").toBe("ejecutando");
    expect(p1.redisEstado.comandosTrasMuerte, "ningún comando a Redis tras la muerte").toBe(0);
    expect(p1.dbEstado.aperturasTrasMuerte, "ninguna transacción tras la muerte").toBe(0);

    // --- proceso 2: relevo ---
    const nuevo = new ProcesadorProgramable();
    const p2 = await arrancar({ prefijo, procesadores: mapa(nuevo) });
    procesos.push(p2);

    await esperarHasta(
      async () => {
        const filas = await Promise.all(todosIds.map((id) => e.fila(id)));
        return filas.every((f) => f.estado === "completado" || f.estado === "error");
      },
      "el reconciliador resuelve los 12 trabajos",
      { timeoutMs: 75_000, cadenciaMs: 250 },
    );
    expect(Date.now() - muerteEn, "CA-10: ≤ 60 s").toBeLessThanOrEqual(60_000);

    for (const id of idempotentes) {
      expect(await e.fila(id), `idempotente ${id}`).toMatchObject({ estado: "completado", intentos: 1, motivo: null });
      expect(nuevo.de(id), "se ejecutó una vez en el proceso nuevo").toHaveLength(1);
      expect(nuevo.de(id)[0]!.intentos).toBe(1);
    }
    for (const id of noIdempotentes) {
      expect(await e.fila(id), `no idempotente ${id}`).toMatchObject({ estado: "error", motivo: "interrumpido", intentos: 0 });
      expect(nuevo.de(id), "un trabajo no idempotente no se reenvía").toHaveLength(0);
    }
    expect(colgado.llamadas, "el proceso muerto no volvió a ejecutar nada").toHaveLength(12);

    // Contadores sin desfase y sin arriendos huérfanos.
    await esperarHasta(async () => (await redis.zcard(k.cupoGlobal("sire"))) === 0, "cupo global en 0");
    expect(await redis.zcard(k.cupoTenant("sire", T))).toBe(0);
    expect((await redis.keys(`${prefijo}ejec:*`)).length).toBe(0);
    expect((await redis.keys(`${prefijo}lock:ruc:*`)).length).toBe(0);
  });
});

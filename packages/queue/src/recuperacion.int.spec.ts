import type { ContappDb } from "@contapp/db";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { tomarEjecucion } from "./arriendos.js";
import { registrarTipo } from "./catalogo.js";
import { crearClaves } from "./claves.js";
import { Despachador } from "./despachador.js";
import { Reconciliador } from "./reconciliador.js";
import {
  anunciar,
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  dormir,
  Escenario,
  esperarHasta,
  fijarConfig,
  limpiarPrefijo,
  nuevoPrefijo,
  RelojAjustable,
  restaurarConfig,
  suscribirEventos,
  type ClientePrueba,
} from "./soporte-pruebas/int.js";

// Spec 008, T5 (integración con PostgreSQL y Redis reales): caída del proceso a mitad de un trabajo (CA-10, D5), a nivel de
// despachador y reconciliador. Contrato que fija (ya implementado en T9):
// - un proceso que muere deja `ejecutando` con `ejec:{jobId}` (si el ejecutor ya había arrancado), el cupo del estudio y el
//   global (ZSET con vencimiento) y el lock del RUC, todos con arriendo de 30 s; el liderazgo de la cola también;
// - vencidos los arriendos, el Reconciliador (trabajos sin cambios en ≥ 30 s) resuelve el `ejecutando`: idempotente con
//   reintentos disponibles → `en_cola` con `intentos + 1`; idempotente sin reintentos o no idempotente → `error`/`interrumpido`
//   (nunca se reenvía); libera cupos y lock y publica el evento; el estudio vuelve a la pista de Redis;
// - los contadores no quedan desfasados: tras N caídas seguidas, los ZSET de cupo vuelven a estar vacíos y no sobra ningún
//   `ejec:*` ni `lock:ruc:*`.
// El tiempo se simula SIN esperar 30 s: reloj inyectable +31 s (puntajes de cupo), PEXPIRE de 1 ms sobre las claves con TTL
// (equivale a que Redis las venza) y `actualizado_en` envejecido con SQL. La espera real de ≤ 60 s la prueba el worker en
// apps/worker/src/trabajos/caida.int.spec.ts.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

registrarTipo({
  tipo: "prueba.no_idempotente",
  cola: "sire",
  canal: "sire",
  credencial: null,
  permiso: "sire.descargar",
  idempotente: false,
  parametros: z.object({ n: z.number().int().optional() }),
});

const prefijo = nuevoPrefijo();
const k = crearClaves(prefijo);
let admin: ContappDb;
let db: ContappDb;
let redis: Redis;
let e: Escenario;
const reloj = new RelojAjustable();

beforeAll(async () => {
  admin = crearDbAdmin();
  db = crearDbRol("contapp_worker", 6);
  redis = conectarRedis();
  e = new Escenario(admin);
  await fijarConfig(admin, "sire", { global: 4, tenant: 2, espera: 0, reintentos: 3 });
});

afterAll(async () => {
  await restaurarConfig(admin).catch(() => undefined);
  await e?.limpiar();
  await limpiarPrefijo(redis, prefijo).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([db?.close(), admin?.close()]);
});

/** Un "proceso" nuevo: otro despachador (otro id de líder); BullMQ no participa, así que nadie ejecuta lo despachado. */
const proceso = () => new Despachador({ db, redis, reloj, prefijo, agregarACola: async () => undefined });
const reconciliador = () => new Reconciliador({ db, redis, reloj, prefijo });
/**
 * El reconciliador repone `tenants:sire` con TODOS los estudios de la base que tengan `en_cola` sin cambios en ≥ 30 s (también
 * los ajenos a la prueba, p. ej. restos de otra suite). Para que el despachador de la prueba no toque trabajos ajenos se dejan
 * en el conjunto solo los estudios de este archivo.
 */
async function soloMios(solo: string[] | null): Promise<void> {
  for (const t of await redis.smembers(k.tenants("sire"))) {
    if (!e.estudios.includes(t) || (solo !== null && !solo.includes(t))) await redis.srem(k.tenants("sire"), t);
  }
}

/** Arranca un proceso nuevo dando por muerto al anterior: su liderazgo (arriendo de 30 s) vence. */
async function arrancar(solo: string[] | null = null): Promise<Despachador> {
  for (const c of await redis.keys(`${prefijo}lider:*`)) await redis.pexpire(c, 1);
  await dormir(10);
  const d = proceso();
  const ciclo = d.ciclo.bind(d);
  d.ciclo = async () => {
    await soloMios(solo);
    await ciclo();
  };
  return d;
}
const estado = async (id: string) => (await e.fila(id)) as { estado: string; motivo: string | null; intentos: number };

/** Siembra un trabajo del tipo dado y lo anuncia. */
async function sembrar(t: string, c: ClientePrueba, tipo: string): Promise<string> {
  const [id] = await e.trabajosEnMasa(t, c, 1, { tipo });
  await anunciar(redis, prefijo, t, [id!]);
  return id!;
}

/** El proceso muere: pasa el tiempo (+31 s, TTL vencidos) y el trabajo envejece. Deja todo listo para el reconciliador. */
async function pasaElTiempo(ids: string[]) {
  reloj.avanzar(31_000);
  const claves = (await redis.keys(`${prefijo}ejec:*`)).concat(await redis.keys(`${prefijo}lock:ruc:*`), await redis.keys(`${prefijo}lider:*`));
  for (const c of claves) await redis.pexpire(c, 1);
  await e.envejecer(ids);
  await dormir(15);
}

const clavesVivas = async (patron: string) => (await redis.keys(`${prefijo}${patron}`)).length;

describe("CA-10: el lock del RUC y el cupo se liberan solos", () => {
  it("idempotente: queda ejecutando con cupo y lock; mientras el arriendo vive otro trabajo del mismo RUC espera; al vencer vuelve a en_cola con un intento consumido", async () => {
    const t = await e.estudio();
    const c = await e.cliente(t);
    const j1 = await sembrar(t, c, "prueba.eco");
    await (await arrancar([t])).ciclo();
    expect((await estado(j1)).estado).toBe("ejecutando");
    expect(await tomarEjecucion(redis, k, j1)).toBe(true); // el ejecutor había arrancado
    expect(await redis.get(k.lockRuc("sire", c.ruc))).toBe(j1);
    expect(await redis.zscore(k.cupoTenant("sire", t), j1)).not.toBeNull();
    expect(await redis.zscore(k.cupoGlobal("sire"), j1)).not.toBeNull();
    expect(await redis.pttl(k.ejec(j1))).toBeLessThanOrEqual(30_000);
    expect(await redis.pttl(k.lockRuc("sire", c.ruc))).toBeLessThanOrEqual(30_000);

    // Otro trabajo del mismo RUC no puede empezar mientras el lock vive.
    const j2 = await sembrar(t, c, "prueba.eco");
    await proceso().ciclo(); // otro líder no entra: el liderazgo también vive
    await reconciliador().ciclo();
    expect((await estado(j1)).estado, "con el arriendo vivo el reconciliador no toca el trabajo").toBe("ejecutando");
    expect((await estado(j2)).estado).toBe("en_cola");

    await pasaElTiempo([j1]);
    const resumen = await reconciliador().ciclo();
    expect(resumen.reencolados).toBeGreaterThanOrEqual(1);
    expect(await estado(j1)).toMatchObject({ estado: "en_cola", intentos: 1, motivo: null });
    expect(await redis.exists(k.lockRuc("sire", c.ruc))).toBe(0);
    expect(await redis.zscore(k.cupoTenant("sire", t), j1)).toBeNull();
    expect(await redis.zscore(k.cupoGlobal("sire"), j1)).toBeNull();
    expect(await redis.sismember(k.tenants("sire"), t)).toBe(1);

    // Un proceso nuevo despacha de nuevo (j1 es el más antiguo del RUC).
    await proceso().ciclo();
    expect((await estado(j1)).estado).toBe("ejecutando");
  });

  it("no idempotente: queda en error/interrumpido, no se reenvía, libera cupo y lock y publica el evento", async () => {
    const t = await e.estudio();
    const c = await e.cliente(t);
    const ev = await suscribirEventos(prefijo, [t]);
    const j = await sembrar(t, c, "prueba.no_idempotente");
    await (await arrancar([t])).ciclo();
    expect((await estado(j)).estado).toBe("ejecutando");
    await tomarEjecucion(redis, k, j);

    await pasaElTiempo([j]);
    const resumen = await reconciliador().ciclo();
    expect(resumen.interrumpidos).toBeGreaterThanOrEqual(1);
    expect(await estado(j)).toMatchObject({ estado: "error", motivo: "interrumpido", intentos: 0 });
    expect(await redis.exists(k.lockRuc("sire", c.ruc))).toBe(0);
    expect(await redis.zscore(k.cupoTenant("sire", t), j)).toBeNull();
    await esperarHasta(() => ev.de(j).some((x) => x.estado === "error"), "evento de error");
    expect(ev.de(j).find((x) => x.estado === "error")).toMatchObject({ estado: "error", motivo: "interrumpido", id: j });

    // Ningún proceso lo vuelve a despachar.
    await (await arrancar([t])).ciclo();
    await (await arrancar([t])).ciclo();
    expect((await estado(j)).estado).toBe("error");
    await ev.cerrar();
  });

  it("idempotente que cae una y otra vez: se reintenta hasta agotar los reintentos de la configuración y luego queda interrumpido", async () => {
    const t = await e.estudio();
    const c = await e.cliente(t);
    const j = await sembrar(t, c, "prueba.eco");
    for (let caida = 1; caida <= 3; caida++) {
      await (await arrancar([t])).ciclo();
      expect((await estado(j)).estado, `despacho antes de la caída ${caida}`).toBe("ejecutando");
      await tomarEjecucion(redis, k, j);
      await pasaElTiempo([j]);
      await reconciliador().ciclo();
      expect(await estado(j), `tras la caída ${caida}`).toMatchObject({ estado: "en_cola", intentos: caida });
    }
    await (await arrancar([t])).ciclo();
    await tomarEjecucion(redis, k, j);
    await pasaElTiempo([j]);
    await reconciliador().ciclo();
    expect(await estado(j)).toMatchObject({ estado: "error", motivo: "interrumpido", intentos: 3 });
  });

  it("10 caídas seguidas (con y sin ejecutor arrancado) no dejan contadores desfasados: cupos vacíos, sin ejec ni locks, y el cupo global sigue disponible", async () => {
    const tenants: string[] = [];
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const t = await e.estudio();
      tenants.push(t);
      const c = await e.cliente(t);
      const j = await sembrar(t, c, i % 2 === 0 ? "prueba.eco" : "prueba.no_idempotente");
      ids.push(j);
      const p = await arrancar([t]); // proceso nuevo en cada vuelta (otro id de líder) que solo atiende a este estudio
      await p.ciclo();
      expect((await estado(j)).estado, `despachado en la vuelta ${i}`).toBe("ejecutando");
      if (i % 3 !== 0) await tomarEjecucion(redis, k, j); // algunas caen antes de que el ejecutor tome `ejec`
      await pasaElTiempo([j]);
      await reconciliador().ciclo();
    }
    // Pares (idempotentes) → en_cola con un intento; impares (no idempotentes) → interrumpidos.
    for (let i = 0; i < 10; i++) {
      expect(await estado(ids[i]!), `trabajo ${i}`).toMatchObject(
        i % 2 === 0 ? { estado: "en_cola", intentos: 1 } : { estado: "error", motivo: "interrumpido", intentos: 0 },
      );
    }
    expect(await redis.zcard(k.cupoGlobal("sire")), "cupo global").toBe(0);
    for (const t of tenants) expect(await redis.zcard(k.cupoTenant("sire", t)), `cupo del estudio ${t}`).toBe(0);
    expect(await clavesVivas("ejec:*")).toBe(0);
    expect(await clavesVivas("lock:ruc:*")).toBe(0);

    // Sin desfase: un estudio nuevo usa el cupo completo (4 globales) y despacha ya.
    const t = await e.estudio();
    const cs = await Promise.all([e.cliente(t), e.cliente(t)]);
    const nuevos = await e.trabajosEnMasa(t, cs, 2);
    await anunciar(redis, prefijo, t, nuevos);
    const p = await arrancar([t]);
    await p.ciclo();
    await p.ciclo();
    const dos = await e.estados(nuevos);
    expect([...dos.values()].map((x) => x.estado)).toEqual(["ejecutando", "ejecutando"]);
  });
});

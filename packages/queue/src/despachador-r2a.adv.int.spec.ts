// Spec 008 · T15a (ronda adversarial 2a): reintenta por otra vía las correcciones de H-008-1b-1 (cupos reservados antes
// de la transición) y H-008-1b-2 (relojes desfasados), y la de H-008-1a-2 (encolar concurrente) contra el máximo de
// pendientes. PostgreSQL y Redis reales (base 15, prefijo propio); sin BullMQ (`agregarACola` solo anota). Cada prueba
// crea su estudio y clientes y los borra; no cambia `config_sistema` (lee la vigente).
//
// Hallazgos que fija (rojo):
//  1. (H-008-1b-1 por otra vía) El cupo es un miembro del ZSET con el id del trabajo, compartido por quien lo reserve. En
//     un canal sin lock de RUC (`ninguno`, permitido por D7), dos despachadores que se creen líderes eligen el mismo
//     candidato; el que pierde la transición llama `soltar(fila, true)` y BORRA el cupo del ganador. El trabajo del
//     ganador queda `ejecutando` sin cupo y el ciclo siguiente despacha por encima de la concurrencia del estudio (CA-2).
//  2. (H-008-1b-2 por otra vía) Los vencimientos se escriben con max(hora local, TIME de Redis), pero la poda usa solo la
//     hora local. Un líder con el reloj 40 s atrasado no poda el cupo de un worker muerto hace 60 s (arriendo vencido
//     hace 30 s según Redis): el estudio queda frenado más allá de los 60 s de CA-10.
//  3. (H-008-1a-2 por otra vía) `encolar` cuenta los pendientes y luego inserta sin atomicidad: con 1 lugar libre bajo el
//     máximo de pendientes (D8), encolados concurrentes de trabajos distintos lo superan.
import { randomUUID } from "node:crypto";
import type { ContappDb } from "@contapp/db";
import type { Redis } from "ioredis";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registrarTipo } from "./catalogo.js";
import { crearClaves } from "./claves.js";
import { Despachador } from "./despachador.js";
import { encolar } from "./encolado.js";
import {
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  Escenario,
  limpiarPrefijo,
  RelojAjustable,
  type ClientePrueba,
} from "./soporte-pruebas/int.js";
import type { PayloadTrabajo } from "./tipos.js";

const prefijo = `r2a-q-${randomUUID().slice(0, 8)}:`;
const k = crearClaves(prefijo);
let admin: ContappDb;
let worker: ContappDb;
let backend: ContappDb;
let redis: Redis;
let e: Escenario;
let limiteEstudio: number;
let maxPendientes: number;

// Tipo sin lock de RUC (canal `ninguno`, D7), como los que usará la cola xml: solo cupos de estudio y global.
registrarTipo({
  tipo: "prueba.sin_canal",
  cola: "sire",
  canal: "ninguno",
  credencial: null,
  permiso: null,
  idempotente: true,
  parametros: z.object({ n: z.number().int().optional() }),
});

beforeAll(async () => {
  admin = crearDbAdmin();
  worker = crearDbRol("contapp_worker", 6);
  backend = crearDbRol("contapp_backend", 12);
  redis = conectarRedis();
  e = new Escenario(admin);
  const r = await admin.pool.query(
    "select concurrencia_tenant, concurrencia_global, max_pendientes_tenant from config_sistema where cola = 'sire'",
  );
  limiteEstudio = Number(r.rows[0].concurrencia_tenant);
  maxPendientes = Number(r.rows[0].max_pendientes_tenant);
  expect(limiteEstudio).toBeLessThan(Number(r.rows[0].concurrencia_global));
}, 30_000);

afterAll(async () => {
  await e?.limpiar();
  await limpiarPrefijo(redis, prefijo).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([worker?.close(), backend?.close(), admin?.close()]);
});

async function ejecutando(T: string): Promise<string[]> {
  const r = await admin.pool.query(
    "select id from job_registro where tenant_id = $1 and estado = 'ejecutando'",
    [T],
  );
  return (r.rows as Array<{ id: string }>).map((f) => f.id);
}

const anotar =
  (lista: PayloadTrabajo[]) => async (_cola: string, p: PayloadTrabajo) => {
    lista.push(p);
  };

/** Redis que se detiene (una vez) justo después de la reserva de cupos (2.º ZADD sin XX) hasta `puerta`. */
function redisQueSeDetieneTrasReservar(
  puerta: Promise<void>,
  aviso: () => void,
): Redis {
  let zadds = 0;
  let detenido = false;
  return new Proxy(redis, {
    get(t, p, rcv) {
      if (p === "zadd")
        return async (...a: unknown[]) => {
          const r = await (
            t.zadd as (...x: unknown[]) => Promise<unknown>
          ).apply(t, a);
          if (!a.includes("XX") && ++zadds === 2 && !detenido) {
            detenido = true;
            aviso();
            await puerta;
          }
          return r;
        };
      const v = Reflect.get(t, p, rcv);
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as Redis;
}

describe("H-008-1b-1 por otra vía: canal sin lock de RUC y dos despachadores", () => {
  it("el perdedor de la transición no borra el cupo del ganador: el estudio no pasa de su concurrencia", async () => {
    const T = await e.estudio();
    const clientes: ClientePrueba[] = [];
    for (let i = 0; i < limiteEstudio + 3; i++)
      clientes.push(await e.cliente(T));
    await e.trabajosEnMasa(T, clientes, limiteEstudio + 3, {
      tipo: "prueba.sin_canal",
      canal: "ninguno",
    });
    await redis.sadd(k.tenants("sire"), T);
    await redis.del(k.lider("sire"));

    let liberar!: () => void;
    const puerta = new Promise<void>((r) => (liberar = r));
    let enPuerta = false;
    const d1 = new Despachador({
      db: worker,
      redis: redisQueSeDetieneTrasReservar(puerta, () => (enPuerta = true)),
      reloj: { ahora: () => new Date() },
      prefijo,
      agregarACola: anotar([]),
    });
    const d2 = new Despachador({
      db: worker,
      redis,
      reloj: { ahora: () => new Date() },
      prefijo,
      agregarACola: anotar([]),
    });

    // D1 lee la ventana, reserva el cupo del primer candidato y se demora (BD lenta / event loop bloqueado).
    const ciclo1 = d1.ciclo();
    for (let i = 0; i < 300 && !enPuerta; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(enPuerta).toBe(true);
    // Su liderazgo vence: D2 lo toma y despacha el MISMO candidato (sin lock de RUC nada lo impide).
    await redis.del(k.lider("sire"));
    await d2.ciclo();
    expect((await ejecutando(T)).length).toBe(1);
    // D1 sigue: pierde la transición de ese candidato y suelta "sus" cupos, que son los del ganador.
    liberar();
    await ciclo1;
    // D2 (líder) sigue despachando con normalidad.
    await redis.del(k.lider("sire"));
    for (let i = 0; i < limiteEstudio + 2; i++) await d2.ciclo();
    const vivos = await ejecutando(T);
    const cupos = await redis.zcard(k.cupoTenant("sire", T));
    expect(
      {
        ejecutando: vivos.length <= limiteEstudio,
        cuposCubrenLoQueCorre: cupos >= vivos.length,
      },
      `ejecutando=${vivos.length}, cupos del estudio=${cupos}, concurrencia del estudio=${limiteEstudio}`,
    ).toEqual({ ejecutando: true, cuposCubrenLoQueCorre: true });
  });
});

describe("H-008-1b-2 por otra vía: líder con el reloj atrasado", () => {
  it("un cupo de un worker muerto hace 60 s (vencido hace 30 s según Redis) no frena al estudio (CA-10, ≤ 60 s)", async () => {
    const T = await e.estudio();
    const clientes: ClientePrueba[] = [];
    for (let i = 0; i < 2; i++) clientes.push(await e.cliente(T));
    const ids = await e.trabajosEnMasa(T, clientes, 2);
    // Disponibles desde hace 2 min: el reloj atrasado del líder no los ve "del futuro" (aísla el efecto de los cupos).
    await admin.pool.query(
      "update job_registro set disponible_desde = now() - interval '2 minutes', creado_en = creado_en - interval '2 minutes' where id = any($1::uuid[])",
      [ids],
    );
    await redis.sadd(k.tenants("sire"), T);
    await redis.del(k.lider("sire"));

    // Trabajos de un worker que murió hace 60 s: su último latido fue entonces (cupo hasta -30 s) y su `ejec:` ya venció.
    const [s, us] = await redis.time();
    const ahoraRedis = Number(s) * 1000 + Math.floor(Number(us) / 1000);
    for (let i = 0; i < limiteEstudio; i++) {
      const muerto = randomUUID();
      await redis.zadd(k.cupoTenant("sire", T), ahoraRedis - 30_000, muerto);
      await redis.zadd(k.cupoGlobal("sire"), ahoraRedis - 30_000, muerto);
    }
    const atrasado = new RelojAjustable();
    atrasado.avanzar(-40_000);
    const payloads: PayloadTrabajo[] = [];
    const lider = new Despachador({
      db: worker,
      redis,
      reloj: atrasado,
      prefijo,
      agregarACola: anotar(payloads),
    });
    await lider.ciclo();
    const conAtrasado = (await ejecutando(T)).length;
    // Control: el mismo estado con un líder de reloj correcto sí despacha (el estudio no tiene otro freno).
    await redis.del(k.lider("sire"));
    const correcto = new Despachador({
      db: worker,
      redis,
      reloj: { ahora: () => new Date() },
      prefijo,
      agregarACola: anotar([]),
    });
    await correcto.ciclo();
    const conCorrecto = (await ejecutando(T)).length;
    expect(
      { conAtrasado: conAtrasado > 0, conCorrecto: conCorrecto > 0 },
      "el líder atrasado sigue contando cupos vencidos hace 30 s (según Redis) y el estudio no despacha",
    ).toEqual({ conAtrasado: true, conCorrecto: true });
  });
});

describe("H-008-1a-2 por otra vía: máximo de pendientes con encolados concurrentes (D8)", () => {
  it("con un solo lugar libre, 10 encolados concurrentes de trabajos distintos no superan el máximo del estudio", async () => {
    const T = await e.estudio();
    const c = await e.cliente(T);
    await e.trabajosEnMasa(T, c, maxPendientes - 1);
    const resultados = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        backend.withTenant({ tenantId: T }, (tx) =>
          encolar(tx, {
            tipo: "prueba.eco",
            clienteId: c.id,
            parametros: { n: 900_000 + i },
            prioridad: "interactivo",
            creadoPor: null,
          }),
        ),
      ),
    );
    const r = await admin.pool.query(
      "select count(*)::int as n from job_registro where tenant_id = $1 and cola = 'sire' and estado = 'en_cola'",
      [T],
    );
    const aceptados = resultados.filter((x) => x.status === "fulfilled").length;
    expect(
      r.rows[0].n,
      `pendientes=${r.rows[0].n} (máximo ${maxPendientes}); encolados aceptados=${aceptados} de 10`,
    ).toBeLessThanOrEqual(maxPendientes);
  });
});

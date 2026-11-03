// Spec 008 · T13b (ronda adversarial 1b, caja blanca): límites de concurrencia del despachador entre procesos.
// PostgreSQL y Redis reales (base 15, prefijo propio); sin BullMQ (el puerto `agregarACola` solo anota). Cada prueba
// crea su estudio y clientes y los borra; no cambia `config_sistema` (lee la concurrencia por estudio vigente).
//
// Hallazgos que fija (rojo):
//  1. Dos líderes: `liderar()` se comprueba una sola vez al empezar la cola; si el ciclo se demora más que el arriendo
//     (30 s: BD lenta, event loop bloqueado), otro proceso toma el liderazgo y ambos despachan. El cupo del estudio se
//     cuenta ANTES del withTenant y se toma DESPUÉS del commit, sin atomicidad: el estudio supera su concurrencia (CA-2).
//  2. Reloj desfasado: los ZSET de cupo guardan el vencimiento con el reloj de quien escribe (despachador o latido del
//     ejecutor) y el líder los poda con el suyo. Un líder adelantado 40 s ve vencidos los cupos que el latido de otro
//     proceso acaba de renovar y despacha por encima de la concurrencia del estudio (CA-2, D5).
import { randomUUID } from "node:crypto";
import type { ContappDb } from "@contapp/db";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renovarArriendos } from "./arriendos.js";
import { crearClaves } from "./claves.js";
import { Despachador } from "./despachador.js";
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

const prefijo = `r1b-q-${randomUUID().slice(0, 8)}:`;
const k = crearClaves(prefijo);
let admin: ContappDb;
let worker: ContappDb;
let redis: Redis;
let e: Escenario;
let limiteEstudio: number;

beforeAll(async () => {
  admin = crearDbAdmin();
  worker = crearDbRol("contapp_worker", 6);
  redis = conectarRedis();
  e = new Escenario(admin);
  const r = await admin.pool.query(
    "select concurrencia_tenant, concurrencia_global from config_sistema where cola = 'sire'",
  );
  limiteEstudio = Number(r.rows[0].concurrencia_tenant);
  // El límite del estudio debe ser el que manda (y no el global) para que la prueba tenga sentido.
  expect(limiteEstudio).toBeLessThan(Number(r.rows[0].concurrencia_global));
}, 30_000);

afterAll(async () => {
  await e?.limpiar();
  await limpiarPrefijo(redis, prefijo).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([worker?.close(), admin?.close()]);
});

/** Estudio con `n` trabajos `prueba.eco` en_cola, cada uno de un cliente (RUC) distinto, y su pista en Redis. */
async function estudioConPendientes(
  n: number,
): Promise<{ T: string; clientes: ClientePrueba[]; ids: string[] }> {
  const T = await e.estudio();
  const clientes: ClientePrueba[] = [];
  for (let i = 0; i < n; i++) clientes.push(await e.cliente(T));
  const ids = await e.trabajosEnMasa(T, clientes, n);
  await redis.sadd(k.tenants("sire"), T);
  return { T, clientes, ids };
}

async function ejecutando(
  T: string,
): Promise<Array<{ id: string; ruc: string }>> {
  const r = await admin.pool.query(
    "select id, ruc from job_registro where tenant_id = $1 and estado = 'ejecutando'",
    [T],
  );
  return r.rows as Array<{ id: string; ruc: string }>;
}

const anotar =
  (lista: PayloadTrabajo[]) => async (_cola: string, p: PayloadTrabajo) => {
    lista.push(p);
  };

describe("dos despachadores que se creen líderes (arriendo vencido a mitad del ciclo)", () => {
  it("el estudio nunca pasa de su concurrencia aunque el líder anterior termine su ciclo tarde", async () => {
    const { T } = await estudioConPendientes(limiteEstudio + 3);
    await redis.del(k.lider("sire"));

    // D1: su primer withTenant se detiene (BD lenta / event loop bloqueado) DESPUÉS de liderar y contar cupos.
    let liberar!: () => void;
    const puerta = new Promise<void>((r) => (liberar = r));
    let detenido = false;
    const lento = new Proxy(worker, {
      get(t, p, rcv) {
        if (p === "withTenant")
          return async (...a: Parameters<ContappDb["withTenant"]>) => {
            if (!detenido) {
              detenido = true;
              await puerta;
            }
            return (
              t.withTenant as (...x: unknown[]) => Promise<unknown>
            ).apply(t, a);
          };
        const v = Reflect.get(t, p, rcv);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as ContappDb;
    const p1: PayloadTrabajo[] = [];
    const p2: PayloadTrabajo[] = [];
    const d1 = new Despachador({
      db: lento,
      redis,
      reloj: { ahora: () => new Date() },
      prefijo,
      agregarACola: anotar(p1),
    });
    const d2 = new Despachador({
      db: worker,
      redis,
      reloj: { ahora: () => new Date() },
      prefijo,
      agregarACola: anotar(p2),
    });

    const ciclo1 = d1.ciclo();
    for (let i = 0; i < 200 && !detenido; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(detenido).toBe(true);

    // Pasan > 30 s: el arriendo de liderazgo de D1 vence y D2 lo toma y despacha hasta llenar el cupo del estudio.
    await redis.del(k.lider("sire"));
    for (let i = 0; i < limiteEstudio + 2; i++) await d2.ciclo();
    expect((await ejecutando(T)).length).toBe(limiteEstudio);

    // D1 sigue su ciclo como si fuera líder.
    liberar();
    await ciclo1;
    const vivos = await ejecutando(T);
    expect(
      vivos.length,
      `ejecutando=${vivos.length} con concurrencia del estudio ${limiteEstudio}`,
    ).toBeLessThanOrEqual(limiteEstudio);
  });
});

describe("reloj desfasado entre procesos", () => {
  it("un líder adelantado 40 s no despacha por encima del cupo del estudio que el latido de otro proceso mantiene vivo", async () => {
    const { T, clientes } = await estudioConPendientes(limiteEstudio + 3);
    await redis.del(k.lider("sire"));
    const adelantado = new RelojAjustable();
    adelantado.avanzar(40_000);
    const payloads: PayloadTrabajo[] = [];
    const lider = new Despachador({
      db: worker,
      redis,
      reloj: adelantado,
      prefijo,
      agregarACola: anotar(payloads),
    });

    for (let i = 0; i < limiteEstudio + 2; i++) await lider.ciclo();
    const enCurso = await ejecutando(T);
    expect(enCurso.length).toBe(limiteEstudio);

    // El ejecutor de OTRO proceso (reloj correcto) renueva sus arriendos con el latido, como lo hace cada 10 s.
    for (const f of enCurso) {
      const c = clientes.find((x) => x.ruc === f.ruc)!;
      await renovarArriendos(
        redis,
        k,
        { id: f.id, tenantId: T, cola: "sire", canal: "sire", ruc: c.ruc },
        Date.now(),
      );
    }
    await lider.ciclo();
    const vivos = await ejecutando(T);
    expect(
      vivos.length,
      `ejecutando=${vivos.length} con concurrencia del estudio ${limiteEstudio}`,
    ).toBeLessThanOrEqual(limiteEstudio);
  });
});

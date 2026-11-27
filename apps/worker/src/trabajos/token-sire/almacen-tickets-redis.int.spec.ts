import { crearClaves, type ClavesCola } from "@contapp/queue";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  conectarRedis,
  esperarHasta,
  limpiarPrefijo,
  nuevoPrefijo,
  volcarPrefijo,
} from "../../../test/trabajos.js";
import { AlmacenTicketsRedis } from "./almacen-tickets-redis.js";

// Spec 041 · T4 (rojo; integración con Redis real): `AlmacenTicketsSire` sobre Redis (plan, «Archivos del worker»; CA-8, CA-12).
//
// CONTRATO que fija (T7), en apps/worker/src/trabajos/token-sire/almacen-tickets-redis.ts:
// - `new AlmacenTicketsRedis({ redis, prefijo? })` implementa `AlmacenTicketsSire` de `@contapp/sunat`
//   (`leer(clave) → string | null`, `guardar(clave, numTicket, ttlMs)`, `borrar(clave)`), con `GET`, `SET … PX` y `DEL`.
// - La `clave` que entrega `HttpSireApiClient` es `"{tenantId}:{clienteId}:{libro}:{periodo}:{operacion}"` (la `claveReanudacion`
//   `"{tenantId}:{clienteId}"` más libro, periodo y operación). Se guarda en Redis en
//   `crearClaves(prefijo).ticketSire(tenantId, clienteId, libro, periodo, operacion)` (queue, claves-041.spec.ts).
// - El valor guardado es SOLO el número de ticket, en claro (no es un secreto); nunca lleva token ni credenciales.
// - El TTL de Redis es `ttlMs`; vencido el plazo, `leer` devuelve `null`. `borrar` de una clave ausente no falla.

const T1 = "0190a000-0000-7000-8000-0000000000a1";
const T2 = "0190a000-0000-7000-8000-0000000000a2";
const C1 = "0190a000-0000-7000-8000-0000000000c1";
const TICKET = "20260000123456";

/** `ticketSire` lo agrega T7 a `ClavesCola` (queue); hasta entonces se declara aquí. */
type ClavesConTicket = ClavesCola & {
  ticketSire(
    tenantId: string,
    clienteId: string,
    libro: string,
    periodo: string,
    operacion: string,
  ): string;
};

let redis: Redis;
const prefijos: string[] = [];

beforeAll(() => {
  redis = conectarRedis();
});

afterAll(async () => {
  for (const p of prefijos)
    await limpiarPrefijo(redis, p).catch(() => undefined);
  redis?.disconnect();
});

function almacen() {
  const prefijo = nuevoPrefijo();
  prefijos.push(prefijo);
  return {
    prefijo,
    k: crearClaves(prefijo) as ClavesConTicket,
    a: new AlmacenTicketsRedis({ redis, prefijo }),
  };
}
const clave = (t: string, c: string, libro = "compras", per = "202610", op = "propuesta") =>
  `${t}:${c}:${libro}:${per}:${op}`;

describe("AlmacenTicketsRedis (CA-8)", () => {
  it("leer de una clave ausente devuelve null", async () => {
    const { a } = almacen();
    expect(await a.leer(clave(T1, C1))).toBeNull();
  });

  it("guardar y leer: devuelve el número de ticket; en Redis queda en la clave ticketSire con TTL", async () => {
    const { a, k } = almacen();
    await a.guardar(clave(T1, C1), TICKET, 3_600_000);
    expect(await a.leer(clave(T1, C1))).toBe(TICKET);
    const enRedis = k.ticketSire(T1, C1, "compras", "202610", "propuesta");
    expect(await redis.get(enRedis)).toBe(TICKET);
    const ttl = await redis.pttl(enRedis);
    expect(ttl).toBeGreaterThan(3_500_000);
    expect(ttl).toBeLessThanOrEqual(3_600_000);
  });

  it("libro y operación se reflejan en la clave de Redis (ventas/registro)", async () => {
    const { a, k } = almacen();
    await a.guardar(clave(T1, C1, "ventas", "202609", "registro"), TICKET, 60_000);
    expect(
      await redis.get(k.ticketSire(T1, C1, "ventas", "202609", "registro")),
    ).toBe(TICKET);
  });

  it("estudios distintos con el mismo cliente no se ven entre sí", async () => {
    const { a } = almacen();
    await a.guardar(clave(T1, C1), "111", 60_000);
    expect(await a.leer(clave(T2, C1))).toBeNull();
    await a.guardar(clave(T2, C1), "222", 60_000);
    expect(await a.leer(clave(T1, C1))).toBe("111");
    expect(await a.leer(clave(T2, C1))).toBe("222");
  });

  it("guardar sobre una clave existente la reemplaza (y renueva el TTL)", async () => {
    const { a, k } = almacen();
    await a.guardar(clave(T1, C1), "111", 10_000);
    await a.guardar(clave(T1, C1), "222", 3_000_000);
    expect(await a.leer(clave(T1, C1))).toBe("222");
    expect(
      await redis.pttl(k.ticketSire(T1, C1, "compras", "202610", "propuesta")),
    ).toBeGreaterThan(2_000_000);
  });

  it("borrar elimina el ticket; borrar de una clave ausente no falla", async () => {
    const { a, k } = almacen();
    await a.guardar(clave(T1, C1), TICKET, 60_000);
    await a.borrar(clave(T1, C1));
    expect(await a.leer(clave(T1, C1))).toBeNull();
    expect(
      await redis.exists(k.ticketSire(T1, C1, "compras", "202610", "propuesta")),
    ).toBe(0);
    await expect(a.borrar(clave(T1, C1))).resolves.toBeUndefined();
  });

  it("vencido el TTL, leer devuelve null", async () => {
    const { a } = almacen();
    await a.guardar(clave(T1, C1), TICKET, 150);
    expect(await a.leer(clave(T1, C1))).toBe(TICKET);
    await esperarHasta(async () => (await a.leer(clave(T1, C1))) === null, "el ticket vence", {
      timeoutMs: 5_000,
    });
  });

  it("otro prefijo no ve los tickets de este (pruebas y procesos aislados)", async () => {
    const uno = almacen();
    const otro = almacen();
    await uno.a.guardar(clave(T1, C1), TICKET, 60_000);
    expect(await otro.a.leer(clave(T1, C1))).toBeNull();
  });

  it("CA-12: en Redis solo queda el número de ticket (ni token ni credenciales)", async () => {
    const { a, prefijo } = almacen();
    await a.guardar(clave(T1, C1), TICKET, 60_000);
    const volcado = await volcarPrefijo(redis, prefijo);
    expect(volcado).toContain(TICKET);
    expect(volcado.toLowerCase()).not.toMatch(/token|secret|clave_sol|bearer/);
  });
});

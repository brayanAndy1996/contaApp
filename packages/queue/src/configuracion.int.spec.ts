import type { ContappDb } from "@contapp/db";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  anunciar,
  armar,
  conectarRedis,
  crearDbAdmin,
  Escenario,
  esperarHasta,
  fijarConfig,
  limpiarPrefijo,
  nuevoPrefijo,
  restaurarConfig,
} from "./soporte-pruebas/int.js";

// Spec 008, T5 (integración con PostgreSQL y Redis reales): configuración en caliente (CA-4, RNF-040).
// Contrato que fija (ya implementado en T9): el despachador relee `config_sistema` cada ≤ 10 s (reloj real) sin reiniciar;
// un valor fuera de rango no entra a la tabla (CHECK, SQLSTATE 23514) y la fila vigente no cambia. La concurrencia
// efectiva se mide en memoria (EjecutorMinimo.maxPorTenant / maxGlobal), no con Redis. Reintentos y backoff en caliente
// (lo que lee el ejecutor del worker) se prueban en apps/worker/src/trabajos/ejecutor.int.spec.ts.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let admin: ContappDb;
let redis: Redis;
let e: Escenario;
const prefijos: string[] = [];
/** Un prefijo nuevo por despachador: el liderazgo (30 s) del anterior no debe frenar al siguiente. */
const prefijoNuevo = () => {
  const p = nuevoPrefijo();
  prefijos.push(p);
  return p;
};

beforeAll(async () => {
  admin = crearDbAdmin();
  redis = conectarRedis();
  e = new Escenario(admin);
  await restaurarConfig(admin);
});

afterAll(async () => {
  await restaurarConfig(admin).catch(() => undefined);
  await e?.limpiar();
  for (const p of prefijos)
    await limpiarPrefijo(redis, p).catch(() => undefined);
  redis?.disconnect();
  await admin?.close();
});

const leer = async () =>
  (await admin.pool.query("select * from config_sistema where cola = 'sire'"))
    .rows[0];

describe("CA-4: cambios de config_sistema sin reiniciar", () => {
  it("subir la concurrencia del estudio de 1 a 2 se aplica en ≤ 10 s, sin reiniciar el despachador", async () => {
    await fijarConfig(admin, "sire", { global: 1, tenant: 1, espera: 0 });
    const t = await e.estudio();
    const clientes = await Promise.all(
      Array.from({ length: 30 }, () => e.cliente(t)),
    );
    const ids = await e.trabajosEnMasa(t, clientes, 30);
    const prefijo = prefijoNuevo();
    const a = await armar({ prefijo, duracionMs: 600 }); // con tenant = 1 son ~18 s: da tiempo al cambio
    try {
      await anunciar(redis, prefijo, t, ids);
      await esperarHasta(
        () => a.ejecutor.iniciados.length >= 1,
        "primer trabajo en ejecución",
      );
      // Con tenant = 1 nunca hay dos a la vez.
      expect(a.ejecutor.maxPorTenant.get(t)).toBe(1);

      const cambio = Date.now();
      await fijarConfig(admin, "sire", { global: 4, tenant: 2 });
      await esperarHasta(
        () => (a.ejecutor.maxPorTenant.get(t) ?? 0) >= 2,
        "dos trabajos del estudio a la vez",
        { timeoutMs: 14_000 },
      );
      expect(Date.now() - cambio).toBeLessThanOrEqual(10_500);
      expect(a.ejecutor.maxPorTenant.get(t)).toBeLessThanOrEqual(2);
      expect(a.ejecutor.maxGlobal).toBeLessThanOrEqual(4);
    } finally {
      await a.detener();
    }
  });

  it("bajar la concurrencia también se aplica: pasados 10 s del cambio no hay dos trabajos del estudio a la vez", async () => {
    await fijarConfig(admin, "sire", { global: 4, tenant: 2, espera: 0 });
    const t = await e.estudio();
    const clientes = await Promise.all(
      Array.from({ length: 80 }, () => e.cliente(t)),
    );
    const ids = await e.trabajosEnMasa(t, clientes, 80);
    const prefijo = prefijoNuevo();
    const a = await armar({ prefijo, duracionMs: 400 });
    try {
      await anunciar(redis, prefijo, t, ids);
      await esperarHasta(
        () => (a.ejecutor.maxPorTenant.get(t) ?? 0) >= 2,
        "dos a la vez con el tope inicial",
      );
      await fijarConfig(admin, "sire", { tenant: 1 }); // global 4, tenant 1
      const limite = Date.now() + 10_500; // CA-4: a partir de aquí ya rige el valor nuevo
      await esperarHasta(
        () => a.ejecutor.marcas.filter((m) => m.inicio > limite).length >= 3,
        "tres trabajos iniciados con el tope nuevo",
        {
          timeoutMs: 25_000,
        },
      );
      const posteriores = a.ejecutor.marcas.filter((m) => m.inicio > limite);
      const solapes = posteriores.filter((m, i) =>
        posteriores.some(
          (o, j) => j !== i && o.inicio < m.fin && m.inicio < o.fin,
        ),
      );
      expect(solapes).toHaveLength(0);
    } finally {
      await a.detener();
    }
  });

  // Intento de UPDATE con el rol administrativo (los CHECK de la tabla se aplican igual); SQL estático con parámetros.
  const intentar = (c: {
    global?: number;
    tenant?: number;
    espera?: number;
    reintentos?: number;
    base?: number;
    maxPendientes?: number;
  }) =>
    admin.pool
      .query(
        `update config_sistema set
           concurrencia_global = coalesce($1, concurrencia_global), concurrencia_tenant = coalesce($2, concurrencia_tenant),
           espera_ruc_ms = coalesce($3, espera_ruc_ms), reintentos = coalesce($4, reintentos),
           backoff_base_ms = coalesce($5, backoff_base_ms), max_pendientes_tenant = coalesce($6, max_pendientes_tenant)
         where cola = 'sire'`,
        [
          c.global ?? null,
          c.tenant ?? null,
          c.espera ?? null,
          c.reintentos ?? null,
          c.base ?? null,
          c.maxPendientes ?? null,
        ],
      )
      .then(
        () => null,
        (x: { code?: string }) => x,
      );

  it.each([
    ["concurrencia global 0", { global: 0 }],
    ["concurrencia global negativa", { global: -1 }],
    ["concurrencia global enorme", { global: 65 }],
    ["concurrencia del estudio mayor que la mitad de la global", { tenant: 3 }],
    ["espera por RUC enorme", { espera: 600001 }],
    ["espera por RUC negativa", { espera: -1 }],
    ["reintentos enormes", { reintentos: 11 }],
    ["backoff base diminuto", { base: 99 }],
    ["máximo de pendientes 0", { maxPendientes: 0 }],
  ])(
    "rechaza por CHECK (23514) y la fila no cambia: %s",
    async (_n, cambio) => {
      await fijarConfig(admin, "sire", { global: 4, tenant: 2, espera: 0 });
      const antes = await leer();
      const err = await intentar(cambio);
      expect(err?.code).toBe("23514");
      expect(await leer()).toEqual(antes);
    },
  );

  it("tras un intento rechazado el despachador sigue trabajando con los últimos valores válidos", async () => {
    await fijarConfig(admin, "sire", { global: 2, tenant: 1, espera: 0 });
    expect((await intentar({ global: 0 }))?.code).toBe("23514");
    const t = await e.estudio();
    const clientes = await Promise.all(
      Array.from({ length: 4 }, () => e.cliente(t)),
    );
    const ids = await e.trabajosEnMasa(t, clientes, 4);
    const prefijo = prefijoNuevo();
    const a = await armar({ prefijo, duracionMs: 30 });
    try {
      await anunciar(redis, prefijo, t, ids);
      await esperarHasta(
        () => a.ejecutor.marcas.length >= 4,
        "4 trabajos terminados",
      );
      expect(a.ejecutor.maxPorTenant.get(t)).toBe(1);
    } finally {
      await a.detener();
    }
  });
});

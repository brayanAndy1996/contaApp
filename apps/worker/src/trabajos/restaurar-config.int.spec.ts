import type { ContappDb } from "@contapp/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  crearDbAdmin,
  fijarConfig,
  restaurarConfig,
} from "../../test/trabajos.js";

// Spec 020, DT-2 (CA-4, plan D-3): `restaurarConfig` devuelve las CUATRO colas de `config_sistema` (`sire`, `sol`, `xml` y
// `archivos`) a los valores de sus migraciones (0018 y 0040). Antes dejaba `archivos` como lo hubiera dejado la suite anterior.
// `config_sistema` es global: la prueba cambia las filas y las repone al final, en la misma prueba y en `afterAll`.

const ORIGEN = [
  { cola: "archivos", global: 4, tenant: 2, espera: 0 },
  { cola: "sire", global: 4, tenant: 2, espera: 2000 },
  { cola: "sol", global: 2, tenant: 1, espera: 2000 },
  { cola: "xml", global: 8, tenant: 4, espera: 2000 },
].map((f) => ({
  cola: f.cola,
  concurrencia_global: f.global,
  concurrencia_tenant: f.tenant,
  espera_ruc_ms: f.espera,
  reintentos: 3,
  backoff_base_ms: 5000,
  max_pendientes_tenant: 2000,
}));

let admin: ContappDb;

const leer = async () =>
  (
    await admin.pool.query(
      `select cola, concurrencia_global, concurrencia_tenant, espera_ruc_ms, reintentos, backoff_base_ms, max_pendientes_tenant
         from config_sistema where cola = any($1::text[]) order by cola`,
      [ORIGEN.map((f) => f.cola)],
    )
  ).rows;

beforeAll(() => {
  admin = crearDbAdmin();
});

afterAll(async () => {
  await restaurarConfig(admin).catch(() => undefined);
  await admin?.close();
});

describe("DT-2: restaurarConfig repone las cuatro colas", () => {
  it("cambia `archivos` (y las otras tres), restaura y lee los valores de las migraciones", async () => {
    await restaurarConfig(admin);
    expect(
      await leer(),
      "punto de partida: valores de las migraciones",
    ).toEqual(ORIGEN);

    await fijarConfig(admin, "archivos", {
      global: 8,
      tenant: 4,
      espera: 777,
      reintentos: 1,
      base: 123,
      maxPendientes: 5,
    });
    await fijarConfig(admin, "sire", { reintentos: 0, base: 100, espera: 0 });
    await fijarConfig(admin, "sol", { reintentos: 7 });
    await fijarConfig(admin, "xml", { maxPendientes: 9 });
    expect(await leer(), "el cambio se aplicó").not.toEqual(ORIGEN);

    await restaurarConfig(admin);
    expect(await leer()).toEqual(ORIGEN);
  });
});

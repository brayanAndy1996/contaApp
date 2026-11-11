import type { ContappDb } from "@contapp/db";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { estadoDe, fijarEstado, limpiarArchivos } from "../../../test/archivos.js";
import { limpiarCompras } from "../../../test/compras.js";
import { arrancar007b, esperarTerminal } from "../../../test/procesadores-007b.js";
import {
  Escenario,
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  fijarConfig,
  limpiarPrefijo,
  nuevoPrefijo,
  restaurarConfig,
  type ProcesoWorker,
} from "../../../test/trabajos.js";
import {
  RUC_FIXTURE,
  SireApiControlado,
  boletas290y292,
  contarPropuestas,
  contarVentas,
  encolarDescarga,
  fila,
  mundoVentas,
  ventasDe,
  type MundoVentas,
} from "../../../test/ventas.js";

// Spec 012b, T5 (rojo; integración con PostgreSQL y Redis reales): la descarga de ventas respeta el estado del periodo
// de ventas (P-1, P-9, D5; CA-10). Mismo patrón que la descarga de compras de 014 (`persistidor-compras.int.spec.ts`):
// - Con `venta_periodo` en `generado`, el persistidor de ventas, ya bajo el bloqueo del periodo, lanza `ErrorDatos`: el
//   trabajo termina `error / datos_invalidos` sin reintentos y NO crea propuesta, diferencias ni ventas.
// - `revisado` se acepta en el worker (el permiso `sire.aprobar_generar` se mira al encolar, como 014): la descarga
//   completa y el periodo sigue `revisado`.
// - El estado de OTRO periodo, de OTRO cliente o del OTRO libro no bloquea.

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

let admin: ContappDb;
let backend: ContappDb;
let redis: Redis;
let e: Escenario;
let prefijo = nuevoPrefijo();
const prefijos = [prefijo];
beforeEach(() => {
  prefijo = nuevoPrefijo();
  prefijos.push(prefijo);
});

beforeAll(async () => {
  admin = crearDbAdmin();
  backend = crearDbRol("contapp_backend");
  redis = conectarRedis();
  e = new Escenario(admin);
  await fijarConfig(admin, "sire", { global: 4, tenant: 2, espera: 0, reintentos: 3, base: 100 });
});

afterAll(async () => {
  await restaurarConfig(admin).catch(() => undefined);
  await limpiarArchivos(admin, e?.estudios ?? []).catch(() => undefined);
  await limpiarCompras(admin, e?.estudios ?? []).catch(() => undefined);
  await e?.limpiar();
  for (const x of prefijos) await limpiarPrefijo(redis, x).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([backend?.close(), admin?.close()]);
});

async function conWorker<T>(api: SireApiControlado, fn: (w: ProcesoWorker) => Promise<T>): Promise<T> {
  const w = await arrancar007b({ prefijo, sireApi: api } as Parameters<typeof arrancar007b>[0]);
  api.contarTx = () => w.dbEstado.abiertas;
  try {
    return await fn(w);
  } finally {
    await w.detener({ esperaMs: 2000 });
  }
}

async function descargar(m: MundoVentas, periodo = "202610") {
  const id = await encolarDescarga(backend, redis, prefijo, m, { libro: "ventas", periodo });
  return esperarTerminal(e, id, 30_000);
}

const apiConBoletas = () => new SireApiControlado().responder([...boletas290y292(), fila("B001", "293")]);

describe("descarga de ventas y estado del periodo de ventas", () => {
  it("`generado`: error / datos_invalidos sin reintentos, sin propuesta, diferencias ni ventas nuevas", async () => {
    const api = apiConBoletas();
    await conWorker(api, async () => {
      const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
      await fijarEstado(admin, "ventas", m, "generado");
      const f = await descargar(m);
      expect([f.estado, f.motivo, f.intentos]).toEqual(["error", "datos_invalidos", 0]);
      expect(await contarPropuestas(admin, m.c.id)).toBe(0);
      expect(await contarVentas(admin, m.c.id)).toBe(0);
      expect(await ventasDe(admin, m.c.id)).toEqual([]);
      expect(await estadoDe(admin, "ventas", m.c.id)).toMatchObject({ estado: "generado" });
    });
  });

  it("`generado` con ventas ya descargadas: una descarga nueva no cambia nada", async () => {
    const api = apiConBoletas();
    await conWorker(api, async () => {
      const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
      expect((await descargar(m)).estado).toBe("completado");
      const antes = await ventasDe(admin, m.c.id);
      expect(antes.length).toBeGreaterThan(0);
      await fijarEstado(admin, "ventas", m, "generado");
      api.responder([...boletas290y292(), fila("B001", "293"), fila("B001", "294")]);

      const f = await descargar(m);

      expect([f.estado, f.motivo, f.intentos]).toEqual(["error", "datos_invalidos", 0]);
      expect(await ventasDe(admin, m.c.id)).toEqual(antes);
      expect(await contarPropuestas(admin, m.c.id)).toBe(1);
    });
  });

  it("`revisado` se acepta en el worker (P-9: el permiso se mira al encolar) y el periodo sigue `revisado`", async () => {
    const api = apiConBoletas();
    await conWorker(api, async () => {
      const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
      await fijarEstado(admin, "ventas", m, "revisado");
      const f = await descargar(m);
      expect(f.estado).toBe("completado");
      expect(await contarVentas(admin, m.c.id)).toBe(3);
      expect(await estadoDe(admin, "ventas", m.c.id)).toMatchObject({ estado: "revisado" });
    });
  });

  it("un `generado` de otro periodo, de otro cliente o del libro de compras no bloquea la descarga", async () => {
    const api = apiConBoletas();
    await conWorker(api, async () => {
      const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
      const otro = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
      await fijarEstado(admin, "ventas", m, "generado", "202609"); // otro periodo
      await fijarEstado(admin, "ventas", otro, "generado"); // otro cliente (y estudio)
      await fijarEstado(admin, "compras", m, "generado"); // el otro libro
      const f = await descargar(m);
      expect(f.estado).toBe("completado");
      expect(await contarVentas(admin, m.c.id)).toBe(3);
      // Sin fila de estado equivale a `abierto` (la descarga puede o no crearla).
      expect([null, "abierto"]).toContain((await estadoDe(admin, "ventas", m.c.id))?.estado ?? null);
    });
  });
});

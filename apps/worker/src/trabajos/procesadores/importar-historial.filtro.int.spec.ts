import type { ContappDb } from "@contapp/db";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  arrancar007b,
  esperarTerminal,
} from "../../../test/procesadores-007b.js";
import {
  PERIODOS_6,
  SireRegistroControlado,
  candidatasDe,
  crearDirFixtures,
  encolarImportacion,
  filaRegistro,
  importacionDe,
  iniciarImportacion,
  limpiarAprendizaje,
  rucProveedor,
  type DirFixtures,
} from "../../../test/importar-historial.js";
import { limpiarReglas } from "../../../test/reglas.js";
import { limpiarCompras } from "../../../test/compras.js";
import {
  Escenario,
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  fijarConfig,
  limpiarPrefijo,
  nuevoPrefijo,
  restaurarConfig,
} from "../../../test/trabajos.js";
import { mundoVentas } from "../../../test/ventas.js";

// Spec 025, T11 (integración con PostgreSQL y Redis reales): una fila con tipo de documento 6 y un número que no tiene 11 dígitos
// (`aprenderDeHistorial` la deja pasar; `reglas_importacion_completar` rechazaría TODA la importación con 22023, T10) no puede
// hacer fallar la importación: no es candidata y el resto sí se guarda.

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

let admin: ContappDb;
let backend: ContappDb;
let redis: Redis;
let e: Escenario;
let fx: DirFixtures;
const prefijo = nuevoPrefijo();

beforeAll(async () => {
  admin = crearDbAdmin();
  backend = crearDbRol("contapp_backend");
  redis = conectarRedis();
  e = new Escenario(admin);
  fx = crearDirFixtures();
  await fijarConfig(admin, "sire", {
    global: 4,
    tenant: 2,
    espera: 0,
    reintentos: 1,
    base: 100,
  });
});

afterAll(async () => {
  await restaurarConfig(admin).catch(() => undefined);
  await limpiarAprendizaje(admin, e?.estudios ?? []).catch(() => undefined);
  await limpiarReglas(admin, e?.estudios ?? []).catch(() => undefined);
  await limpiarCompras(admin, e?.estudios ?? []).catch(() => undefined);
  await e?.limpiar();
  await limpiarPrefijo(redis, prefijo).catch(() => undefined);
  redis?.disconnect();
  fx?.limpiar();
  await Promise.all([backend?.close(), admin?.close()]);
});

describe("T10 → T11: documentos que la BD no admite", () => {
  it("un RUC de 10 dígitos y otro de 12 no son candidatas; la importación se completa con las demás", async () => {
    const m = await mundoVentas(e, backend);
    const bueno = rucProveedor(31);
    const periodos = new Map(
      PERIODOS_6.map((p) => [
        p,
        [
          filaRegistro({ periodo: p, numero: "1", ruc: bueno, destino: "DG" }),
          filaRegistro({
            periodo: p,
            numero: "2",
            ruc: "2070000003",
            destino: "DG",
          }),
          filaRegistro({
            periodo: p,
            numero: "3",
            ruc: "207000000345",
            destino: "DG",
          }),
        ],
      ]),
    );
    fx.registro(m.c.ruc, periodos);
    const api = new SireRegistroControlado(fx.dir);
    const p = await arrancar007b({
      prefijo,
      sireApi: api,
    } as Parameters<typeof arrancar007b>[0]);
    try {
      const importacionId = await iniciarImportacion(backend, m, PERIODOS_6);
      const trabajoId = await encolarImportacion(
        backend,
        redis,
        prefijo,
        m,
        importacionId,
      );
      const f = await esperarTerminal(e, trabajoId, 60_000);
      expect([f.estado, f.motivo]).toEqual(["completado", null]);
      expect((f as { resultado?: unknown }).resultado).toEqual({
        periodosLeidos: 6,
        periodosSinDatos: 0,
        candidatas: 1,
        sinCriterio: 0,
      });
      expect(await importacionDe(admin, importacionId)).toMatchObject({
        estado: "completada",
        candidatas: 1,
        sin_criterio: 0,
      });
      const cands = await candidatasDe(admin, { importacionId });
      expect(
        cands.map((c) => [c.doc_tipo, c.doc_numero, c.destino_propuesto]),
      ).toEqual([["6", bueno, "DG"]]);
    } finally {
      await p.detener({ esperaMs: 2000 });
    }
  });
});

// Spec 028 · T17 (H-028-1-1, mismo patrón en `buzon.programar` de 023): `detener` con un tick del programador del buzón en curso (más de
// 5 s) no deja el candado tomado. `iniciarTrabajos` da a los ciclos programados una BD (`dbCandado`) que solo corta `abortar` (kill -9):
// el `finally` del tick suelta su propio candado aunque `detener` ya haya vencido, y el siguiente worker toma el ciclo en cuanto le toca.
// Con `abortar`, en cambio, el candado queda hasta vencer (nada llega a la BD tras la muerte del proceso, CA-10 de 008).
import { randomUUID } from "node:crypto";
import type { ContappDb } from "@contapp/db";
import { crearColaSistema } from "@contapp/queue/worker";
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EscenarioBuzon, ProgramacionGuardada } from "../../../test/buzon.js";
import { limpiarFilas017 } from "../../../test/notificaciones.js";
import { loggerEspia } from "../../../test/soporte.js";
import {
  arrancar,
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  esperarHasta,
  limpiarPrefijo,
  nuevoPrefijo,
  opcionesBull,
} from "../../../test/trabajos.js";
import type { LoggerTrabajos } from "../registro.js";
import { programarBuzon } from "./programar-buzon.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

let admin: ContappDb;
let worker: ContappDb;
let redis: Redis;
let e: EscenarioBuzon;
let prog: ProgramacionGuardada;
const prefijos: string[] = [];
let entornoAnterior: string | undefined;

const silencio = { info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as LoggerTrabajos;

beforeAll(async () => {
  entornoAnterior = process.env.BUZON_PROGRAMADOR;
  admin = crearDbAdmin();
  worker = crearDbRol("contapp_worker", 4);
  redis = conectarRedis();
  prog = new ProgramacionGuardada(admin);
  await prog.guardar();
});

beforeEach(() => {
  process.env.BUZON_PROGRAMADOR = "off";
  e = new EscenarioBuzon(admin);
});

afterEach(async () => {
  await limpiarFilas017(admin, e.estudios).catch(() => undefined);
  await e.limpiar();
  await prog.restaurar();
});

afterAll(async () => {
  if (entornoAnterior === undefined) delete process.env.BUZON_PROGRAMADOR;
  else process.env.BUZON_PROGRAMADOR = entornoAnterior;
  for (const p of prefijos) await limpiarPrefijo(redis, p).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([worker?.close(), admin?.close()]);
});

const candado = async (): Promise<{ dueno: string | null; restanteS: number | null }> => {
  const { rows } = await admin.pool.query(
    "select ciclo_dueno, extract(epoch from ciclo_hasta - clock_timestamp())::float8 as s from buzon_programacion",
  );
  return { dueno: rows[0].ciclo_dueno, restanteS: rows[0].s === null ? null : Number(rows[0].s) };
};

/** Arranca un worker, encola un `buzon.programar` con `buzon_estado_cliente` bloqueada y devuelve cómo cerrarlo y liberar la tabla. */
async function tickBloqueado() {
  const T = await e.estudioConSub({ estado: "activa" });
  await e.clienteBuzon(T);
  await prog.listoParaTomar();
  const prefijo = nuevoPrefijo();
  prefijos.push(prefijo);
  const espia = loggerEspia();
  const terminado = () => espia.llamadas.some((l) => /buzon_ciclo_terminado/.test(JSON.stringify(l.args)));
  const bloqueo = await admin.pool.connect();
  let liberado = false;
  const liberar = async () => {
    if (liberado) return;
    liberado = true;
    await bloqueo.query("commit").catch(() => undefined);
    bloqueo.release();
  };
  const w = await arrancar({ prefijo, logger: espia.logger as unknown as LoggerTrabajos });
  const cola = crearColaSistema({ conexion: opcionesBull(), prefijo });
  await bloqueo.query("begin");
  await bloqueo.query("lock table buzon_estado_cliente in access exclusive mode");
  await cola.encolar({ tipo: "buzon.programar" });
  await esperarHasta(async () => ((await candado()).restanteS ?? 0) > 0, "el tick tomó el candado");
  return { w, cola, liberar, terminado };
}

describe("H-028-1-1 en buzon.programar (023): cerrar el worker con un tick en curso", () => {
  it("detener (vencido a los 5 s) no deja el candado tomado: el tick lo suelta al terminar y otro worker toma el ciclo", async () => {
    const { w, cola, liberar, terminado } = await tickBloqueado();
    try {
      await w.en.detener({ esperaMs: 10_000 });
      await liberar();
      await esperarHasta(async () => terminado(), "el tick en curso terminó", { timeoutMs: 30_000 });
      expect((await candado()).restanteS, "el worker que se detuvo dejó el candado tomado").toBeNull();
      // Pasado el intervalo, otro worker toma el ciclo en su primer tick (sin esperar a que venza un candado ajeno).
      await prog.listoParaTomar();
      const siguiente = await programarBuzon({ db: worker, logger: silencio, dueno: `nuevo-${randomUUID()}` })();
      expect(siguiente.tomado).toBe(true);
    } finally {
      await liberar();
      await cola.cerrar();
      await w.detener({ esperaMs: 2_000 }).catch(() => undefined);
    }
  });

  it("abortar (kill -9) no escribe más: el candado queda tomado hasta vencer", async () => {
    const { w, cola, liberar, terminado } = await tickBloqueado();
    try {
      await w.en.abortar();
      await liberar();
      await esperarHasta(async () => terminado(), "el tick en curso terminó", { timeoutMs: 30_000 });
      expect((await candado()).restanteS ?? 0, "tras abortar nada llega a la BD").toBeGreaterThan(0);
    } finally {
      await liberar();
      await cola.cerrar();
      await w.detener({ esperaMs: 2_000 }).catch(() => undefined);
    }
  });
});

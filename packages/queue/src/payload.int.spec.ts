import { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import { crearColas, crearWorkers, type WorkersBull } from "./worker/index.js";
import type { PayloadTrabajo } from "./tipos.js";
import {
  conectarRedis,
  dormir,
  esperarHasta,
  limpiarPrefijo,
  nuevoPrefijo,
  opcionesBull,
} from "./soporte-pruebas/int.js";

// Spec 008, T5 (integración con Redis y BullMQ reales): el worker solo acepta el payload { jobId, tenantId, tipo } (CA-15).
// Contrato que fija (ya implementado en T9): `crearColas().agregarACola(cola, payload)` encola con el `jobId` de BullMQ = id del
// trabajo y rechaza (lanza) un payload de forma inválida; `crearWorkers({ procesar })` descarta sin llamar a `procesar` cualquier
// job cuyo `data` no sea EXACTAMENTE esas tres claves con uuid, uuid y un tipo con la forma de job_registro.tipo (claves de más,
// tipos de dato distintos, objetos anidados, JSON inválido). Que el `jobId` pertenezca al estudio y el tipo coincida con la fila
// lo comprueba el Ejecutor del worker contra job_registro (apps/worker/src/trabajos/ejecutor.int.spec.ts).

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const prefijo = nuevoPrefijo();
let redis: Redis;
let cola: Queue;
let workers: WorkersBull;
const recibidos: PayloadTrabajo[] = [];
const uuid = () => crypto.randomUUID();

beforeAll(async () => {
  redis = conectarRedis();
  cola = new Queue("sire", {
    connection: opcionesBull(),
    prefix: `${prefijo}bull`,
  });
  workers = crearWorkers({
    conexion: opcionesBull(),
    prefijo,
    colas: [{ cola: "sire", concurrencia: 2 }],
    procesar: async (_c, payload) => {
      recibidos.push(payload);
    },
  });
});

afterAll(async () => {
  await workers?.cerrar();
  await cola?.close();
  await limpiarPrefijo(redis, prefijo).catch(() => undefined);
  redis?.disconnect();
});

describe("CA-15: payload forjado en BullMQ", () => {
  it("un payload válido llega a procesar tal cual, con solo tres claves", async () => {
    const colas = crearColas({ conexion: opcionesBull(), prefijo });
    const payload = { jobId: uuid(), tenantId: uuid(), tipo: "prueba.eco" };
    await colas.agregarACola("sire", payload);
    await esperarHasta(
      () => recibidos.length >= 1,
      "el worker recibe el payload",
    );
    expect(recibidos[0]).toEqual(payload);
    await colas.cerrar();
  });

  it.each([
    [
      "clave de más (parametros)",
      {
        jobId: uuid(),
        tenantId: uuid(),
        tipo: "prueba.eco",
        parametros: { x: 1 },
      },
    ],
    [
      "clave de más (ruc)",
      {
        jobId: uuid(),
        tenantId: uuid(),
        tipo: "prueba.eco",
        ruc: "20100070970",
      },
    ],
    ["falta el tenantId", { jobId: uuid(), tipo: "prueba.eco" }],
    ["falta el jobId", { tenantId: uuid(), tipo: "prueba.eco" }],
    [
      "jobId no uuid",
      { jobId: "1 OR 1=1", tenantId: uuid(), tipo: "prueba.eco" },
    ],
    [
      "tenantId no uuid",
      { jobId: uuid(), tenantId: "../../otro", tipo: "prueba.eco" },
    ],
    [
      "tipo con la forma inválida",
      { jobId: uuid(), tenantId: uuid(), tipo: "Prueba.ECO; drop" },
    ],
    ["tipo como número", { jobId: uuid(), tenantId: uuid(), tipo: 7 }],
    [
      "tenantId como objeto",
      { jobId: uuid(), tenantId: { $ne: null }, tipo: "prueba.eco" },
    ],
    ["un arreglo", [uuid(), uuid(), "prueba.eco"]],
    ["una cadena", "prueba.eco"],
    ["null", null],
  ])("lo forjado no llega a procesar: %s", async (_n, data) => {
    const antes = recibidos.length;
    // Directo a la cola de BullMQ (como lo haría quien tuviera acceso a Redis), sin pasar por el productor.
    await cola.add("prueba.eco", data as never, {
      jobId: uuid(),
      removeOnComplete: true,
      removeOnFail: true,
      attempts: 1,
    });
    await dormir(400);
    expect(recibidos.length).toBe(antes);
  });

  it("el productor rechaza un payload con forma inválida sin dejarlo en la cola", async () => {
    const colas = crearColas({ conexion: opcionesBull(), prefijo });
    await expect(
      colas.agregarACola("sire", {
        jobId: "no-uuid",
        tenantId: uuid(),
        tipo: "prueba.eco",
      } as never),
    ).rejects.toThrow();
    await expect(
      colas.agregarACola("sire", {
        jobId: uuid(),
        tenantId: uuid(),
        tipo: "prueba.eco",
        extra: 1,
      } as never),
    ).rejects.toThrow();
    await colas.cerrar();
    const antes = recibidos.length;
    await dormir(300);
    expect(recibidos.length).toBe(antes);
  });
});

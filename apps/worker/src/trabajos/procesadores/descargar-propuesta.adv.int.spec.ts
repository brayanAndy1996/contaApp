// Spec 013 T17 · ronda adversarial (integración, PostgreSQL real) de la descarga complementaria (D3, D7, D10, D16, D17).
// Caja blanca sobre `descargar-propuesta.ts`, `persistidores/ventas.ts` y `aplicarComplemento` (packages/db):
//  - carrera de dos descargas del MISMO periodo con contenido distinto, justo en 19.999 vivas: el bloqueo advisory las
//    serializa (sin `40P01` ni filas duplicadas). T18 (D19, usuario 2026-11-07): el tope de 20.000 es de las filas que llegan
//    en cada descarga, no del total vivo; antes la segunda excedía el tope y ahora las dos entran;
//  - la serie que llega del SIRE en minúsculas: la importación y el agregar la guardan en mayúsculas (D7: una sola serie
//    para la correlatividad); la descarga debe guardar lo mismo.
// Se invoca el procesador directo con dos trabajos reales, como la carrera de T5 (la cola deduplica las descargas vivas).
import type { ContappDb } from "@contapp/db";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  Escenario,
  limpiarPrefijo,
  nuevoPrefijo,
} from "../../../test/trabajos.js";
import {
  contarVentas,
  encolarDescarga,
  fila,
  liberarDedupe,
  limpiarVentas,
  mundoVentas,
  PERIODO,
  propuestasDe,
  SireApiControlado,
  sembrarVentas,
  TIPO_DESCARGA,
  ventasDe,
  type FilaVenta,
  type MundoVentas,
} from "../../../test/ventas.js";
import { descargarPropuesta } from "./descargar-propuesta.js";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

let admin: ContappDb;
let backend: ContappDb;
let dbWorker: ContappDb;
let redis: Redis;
let e: Escenario;
let prefijo = nuevoPrefijo();
const prefijos = [prefijo];
beforeEach(() => {
  prefijo = nuevoPrefijo();
  prefijos.push(prefijo);
});

beforeAll(() => {
  admin = crearDbAdmin();
  backend = crearDbRol("contapp_backend");
  dbWorker = crearDbRol("contapp_worker");
  redis = conectarRedis();
  e = new Escenario(admin);
});

afterAll(async () => {
  await limpiarVentas(admin, e?.estudios ?? []).catch(() => undefined);
  await e?.limpiar();
  for (const x of prefijos) await limpiarPrefijo(redis, x).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([dbWorker?.close(), backend?.close(), admin?.close()]);
});

/** Contexto mínimo del procesador para un trabajo real ya encolado (sin worker en marcha). */
const ctx = (m: MundoVentas, id: string, periodo = PERIODO) => ({
  trabajo: {
    id,
    tenantId: m.T,
    clienteId: m.c.id,
    ruc: m.c.ruc,
    tipo: TIPO_DESCARGA,
    parametros: { periodo, libro: "ventas" },
    intentos: 0,
    creadoPor: m.u,
  },
  conToken: <T>(usar: (t: string) => Promise<T>) => usar("token-de-prueba"),
});

/** Cancela los trabajos que quedaron en cola sin worker, para que ninguna otra prueba los recoja. */
const cancelarEnCola = (m: MundoVentas) =>
  admin.pool
    .query(
      "update job_registro set estado = 'cancelado', motivo = 'cancelado_usuario', terminado_en = now(), actualizado_en = now() where cliente_id = $1 and estado = 'en_cola'",
      [m.c.id],
    )
    .catch(() => undefined);

describe("T17 · descarga complementaria", () => {
  it("adv-w1: dos descargas simultáneas del mismo periodo con 19.999 vivas, cada una con UNA nueva distinta (3 rondas): las dos entran, serializadas (D19: el tope no cuenta lo ya guardado)", async () => {
    for (let i = 0; i < 3; i++) {
      const m = await mundoVentas(e, backend);
      try {
        await sembrarVentas(admin, m, 19_999);
        let llamada = 0;
        const respuestas: FilaVenta[][] = [[fila("N001", "1")], [fila("N002", "1")]];
        const api = new SireApiControlado().responder(() => respuestas[llamada++ % 2]!);
        api.barrera(2);
        const proc = descargarPropuesta({ db: dbWorker, sireApi: api });
        const a = await encolarDescarga(backend, redis, prefijo, m);
        await liberarDedupe(admin, a);
        const b = await encolarDescarga(backend, redis, prefijo, m);
        const r = await Promise.allSettled([proc(ctx(m, a) as never), proc(ctx(m, b) as never)]);
        expect(
          r.map((x) => x.status),
          `ronda ${i}: ${JSON.stringify(r.filter((x) => x.status === "rejected").map((x) => String((x as PromiseRejectedResult).reason)))}`,
        ).toEqual(["fulfilled", "fulfilled"]);
        expect(await contarVentas(admin, m.c.id), `ronda ${i}: vivas`).toBe(20_001);
        expect(await propuestasDe(admin, m.c.id), `ronda ${i}: la sembrada + una por descarga`).toHaveLength(3);
      } finally {
        await cancelarEnCola(m);
      }
    }
  });

  it("adv-w2: una serie que el SIRE trae en minúsculas («b001») se guarda en mayúsculas, como la importación y el agregar", async () => {
    const m = await mundoVentas(e, backend);
    try {
      const api = new SireApiControlado().responder([fila("b001", "290"), fila("b001", "292")]);
      const proc = descargarPropuesta({ db: dbWorker, sireApi: api });
      const id = await encolarDescarga(backend, redis, prefijo, m);
      await proc(ctx(m, id) as never);
      const ventas = await ventasDe(admin, m.c.id);
      expect(ventas.map((x) => x.clave)).toEqual(["03|B001|290", "03|B001|292"]);
      expect(
        ventas.map((x) => x.serie),
        "con «b001» guardada, agregar «B001-291» (que se guarda en mayúsculas) no cierra el faltante: la correlatividad ve dos series",
      ).toEqual(["B001", "B001"]);
    } finally {
      await cancelarEnCola(m);
    }
  });
});

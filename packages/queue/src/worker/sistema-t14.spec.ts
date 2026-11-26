import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Doble de bullmq (sin Redis): el `Worker` guarda su nombre, su procesador, sus opciones y los oyentes, y
// anota cómo se cierra.
const falso = vi.hoisted(() => ({
  workers: [] as {
    nombre: string;
    procesador: (job: { data: unknown }) => Promise<void>;
    opciones: Record<string, unknown>;
    oyentes: Map<string, () => void>;
    cierres: (boolean | undefined)[];
  }[],
}));

vi.mock("bullmq", () => ({
  Queue: class {
    async close() {}
  },
  Worker: class {
    oyentes = new Map<string, () => void>();
    cierres: (boolean | undefined)[] = [];
    constructor(
      public nombre: string,
      public procesador: (job: { data: unknown }) => Promise<void>,
      public opciones: Record<string, unknown>,
    ) {
      falso.workers.push(this);
    }
    on(evento: string, f: () => void) {
      this.oyentes.set(evento, f);
      return this;
    }
    async close(forzar?: boolean) {
      this.cierres.push(forzar);
    }
  },
}));

import { COLA_SISTEMA, crearWorkerSistema } from "./index.js";

// Spec 028 · T14. `crearWorkerSistema` (worker de la cola `programados`) lo ejerce el arranque del worker de
// 028 con el tick `correo.programar`: un solo hilo, el procesador valida el payload y el cierre acepta `forzar`.
const conexion = { host: "localhost", port: 6379 };

describe("crearWorkerSistema", () => {
  beforeEach(() => {
    falso.workers.length = 0;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("abre un Worker de la cola `programados` con concurrencia 1 y el prefijo indicado", () => {
    crearWorkerSistema({ conexion, prefijo: "t14:", procesar: async () => undefined });
    expect(falso.workers).toHaveLength(1);
    const w = falso.workers[0]!;
    expect(w.nombre).toBe(COLA_SISTEMA);
    expect(w.opciones).toMatchObject({ concurrency: 1, connection: conexion, prefix: "t14:bull" });
  });

  it("entrega al procesador el payload de `correo.programar` y descarta uno forjado sin invocarlo", async () => {
    const procesar = vi.fn(async () => undefined);
    crearWorkerSistema({ conexion, procesar });
    const w = falso.workers[0]!;
    await w.procesador({ data: { tipo: "correo.programar" } });
    expect(procesar).toHaveBeenCalledWith({ tipo: "correo.programar" });
    await w.procesador({ data: { tipo: "correo.programar", extra: "CANARIO-T14" } });
    expect(procesar).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("CANARIO");
  });

  it("un error interno de BullMQ se registra sin propagarse", () => {
    crearWorkerSistema({ conexion, procesar: async () => undefined });
    const oyente = falso.workers[0]!.oyentes.get("error");
    expect(oyente).toBeTypeOf("function");
    expect(() => oyente!()).not.toThrow();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("cerrar cierra el Worker: sin forzar por defecto y forzado si se pide", async () => {
    const worker = crearWorkerSistema({ conexion, procesar: async () => undefined });
    await worker.cerrar();
    await worker.cerrar(true);
    expect(falso.workers[0]!.cierres).toEqual([false, true]);
  });
});

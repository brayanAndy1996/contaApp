import { beforeEach, describe, expect, it, vi } from "vitest";

// Doble de bullmq: sin Redis en las unitarias (la prueba real va en *.int.spec.ts).
const falso = vi.hoisted(() => ({
  colas: [] as {
    nombre: string;
    opciones: Record<string, unknown>;
    agregados: unknown[][];
    cerrada: boolean;
  }[],
  workers: [] as {
    nombre: string;
    procesador: (job: { data: unknown }) => Promise<void>;
    opciones: Record<string, unknown>;
    concurrency: number;
    cerrado: boolean;
  }[],
}));

vi.mock("bullmq", () => ({
  Queue: class {
    agregados: unknown[][] = [];
    cerrada = false;
    constructor(
      public nombre: string,
      public opciones: Record<string, unknown>,
    ) {
      falso.colas.push(this);
    }
    async add(...a: unknown[]) {
      this.agregados.push(a);
    }
    async close() {
      this.cerrada = true;
    }
  },
  Worker: class {
    cerrado = false;
    concurrency: number;
    constructor(
      public nombre: string,
      public procesador: (job: { data: unknown }) => Promise<void>,
      public opciones: Record<string, unknown>,
    ) {
      this.concurrency = opciones.concurrency as number;
      falso.workers.push(this);
    }
    async close() {
      this.cerrado = true;
    }
  },
}));

import { crearColas, crearWorkers, prefijoBull, procesarJob } from "./index.js";

// T9 (backend): adaptador BullMQ de `@contapp/queue/worker` (plan 008, Worker; CA-15).
const ID = "0190a000-0000-7000-8000-000000000001";
const T = "0190a000-0000-7000-8000-0000000000a1";
const conexion = { host: "localhost", port: 6379 };

beforeEach(() => {
  falso.colas = [];
  falso.workers = [];
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("crearColas", () => {
  it("una Queue por cola con el prefijo derivado; jobId = id del trabajo y attempts 1", async () => {
    const c = crearColas({ conexion, prefijo: "p:" });
    await c.agregarACola("sire", { jobId: ID, tenantId: T, tipo: "a.b" });
    await c.agregarACola("sire", { jobId: ID, tenantId: T, tipo: "a.b" });
    await c.agregarACola("sol", { jobId: ID, tenantId: T, tipo: "a.b" });
    expect(falso.colas.map((q) => q.nombre)).toEqual(["sire", "sol"]);
    expect(falso.colas[0]!.opciones).toMatchObject({ prefix: "p:bull" });
    expect(falso.colas[0]!.agregados[0]).toEqual([
      "a.b",
      { jobId: ID, tenantId: T, tipo: "a.b" },
      {
        jobId: ID,
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      },
    ]);
    await c.cerrar();
    expect(falso.colas.every((q) => q.cerrada)).toBe(true);
  });

  it("rechaza un payload con claves de mas (CA-15)", async () => {
    const c = crearColas({ conexion });
    await expect(
      c.agregarACola("sire", {
        jobId: ID,
        tenantId: T,
        tipo: "a.b",
        ruc: "20100000001",
      } as never),
    ).rejects.toThrow();
  });

  it("prefijo por defecto contapp:bull", () => {
    expect(prefijoBull()).toBe("contapp:bull");
  });
});

describe("crearWorkers y procesarJob", () => {
  it("un Worker por cola con su concurrencia, ajustable en caliente", async () => {
    const procesar = vi.fn(async () => undefined);
    const w = crearWorkers({
      conexion,
      colas: [
        { cola: "sire", concurrencia: 4 },
        { cola: "sol", concurrencia: 0 },
      ],
      procesar,
    });
    expect(falso.workers.map((x) => [x.nombre, x.concurrency])).toEqual([
      ["sire", 4],
      ["sol", 1],
    ]);
    expect(falso.workers[0]!.opciones).toMatchObject({
      prefix: "contapp:bull",
    });
    w.ajustarConcurrencia("sire", 8);
    w.ajustarConcurrencia("xml", 8); // sin worker: no hace nada
    expect(falso.workers[0]!.concurrency).toBe(8);
    await falso.workers[0]!.procesador({
      data: { jobId: ID, tenantId: T, tipo: "a.b" },
    });
    expect(procesar).toHaveBeenCalledWith("sire", {
      jobId: ID,
      tenantId: T,
      tipo: "a.b",
    });
    await w.cerrar();
    expect(falso.workers.every((x) => x.cerrado)).toBe(true);
  });

  it.each([
    [{ jobId: "x", tenantId: T, tipo: "a.b" }],
    [{ jobId: ID, tenantId: T, tipo: "Malo" }],
    [{ jobId: ID, tenantId: T, tipo: "a.b", claveSol: "CANARIO-SOL-1" }],
    [null],
  ])("un payload forjado %j no llega al procesador", async (data) => {
    const procesar = vi.fn(async () => undefined);
    await procesarJob("sire", { data }, procesar);
    expect(procesar).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(
      "CANARIO",
    );
  });
});

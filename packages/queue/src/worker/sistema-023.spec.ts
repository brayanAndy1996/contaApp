import { beforeEach, describe, expect, it, vi } from "vitest";

// Doble de bullmq con `upsertJobScheduler` (sin Redis): guarda un repetible por id, como BullMQ.
const falso = vi.hoisted(() => ({
  colas: [] as {
    nombre: string;
    llamadas: unknown[][];
    repetibles: Map<string, unknown[]>;
    agregados: unknown[][];
  }[],
}));

vi.mock("bullmq", () => ({
  Queue: class {
    llamadas: unknown[][] = [];
    repetibles = new Map<string, unknown[]>();
    agregados: unknown[][] = [];
    constructor(public nombre: string) {
      falso.colas.push(this);
    }
    async add(...a: unknown[]) {
      this.agregados.push(a);
    }
    async upsertJobScheduler(...a: unknown[]) {
      this.llamadas.push(a);
      this.repetibles.set(a[0] as string, a);
    }
    async close() {}
  },
  Worker: class {
    async close() {}
    on() {
      return this;
    }
  },
}));

import {
  COLA_SISTEMA,
  crearColaSistema,
  payloadSistemaSchema,
  procesarJobSistema,
} from "./index.js";

// Spec 023 · T2 (rojo). Trabajo de sistema `buzon.programar` (plan 023, Contratos: Cola; D-5). Contrato fijado por estas pruebas
// (packages/queue/src/worker/index.ts):
//  - payloadSistemaSchema acepta `{tipo: "buzon.programar"}` ESTRICTO (sin `job_registro`, D10 de 008); cualquier clave extra se rechaza
//    y `kek.rotar` y `auth.purgar` siguen igual.
//  - ColaSistema.programarBuzon() = `upsertJobScheduler("buzon.programar", {every: 60_000}, {name: "buzon.programar",
//    data: {tipo: "buzon.programar"}, opts})` sobre la cola `programados`: id fijo, así que N workers que lo registran dejan UN repetible.
//    El tick solo pide el ciclo; el intervalo real lo decide la BD.
//  - El repetible no lleva credenciales, tenant ni cliente en su `data`.
const conexion = { host: "localhost", port: 6379 };

beforeEach(() => {
  falso.colas = [];
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("payloadSistemaSchema: buzon.programar", () => {
  it("acepta {tipo: buzon.programar} y lo devuelve igual", () => {
    const r = payloadSistemaSchema.safeParse({ tipo: "buzon.programar" });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ tipo: "buzon.programar" });
  });

  it.each([
    ["clienteId", { clienteId: "x" }],
    ["tenantId", { tenantId: "x" }],
    ["clave", { clave: "CANARIO" }],
    ["intervaloMin", { intervaloMin: 1 }],
    ["desde", { desde: "k1" }],
    ["constructor", { constructor: 1 }],
  ])("rechaza la clave extra %s", (_c, extra) => {
    expect(
      payloadSistemaSchema.safeParse({ tipo: "buzon.programar", ...extra })
        .success,
    ).toBe(false);
  });

  it.each([
    "buzon.programa",
    "Buzon.programar",
    "buzon.programar ",
    "buzon",
    "",
    null,
    1,
    undefined,
  ])("rechaza el tipo %j", (tipo) => {
    expect(payloadSistemaSchema.safeParse({ tipo }).success).toBe(false);
  });

  it("los tipos de sistema previos siguen aceptados", () => {
    expect(
      payloadSistemaSchema.safeParse({ tipo: "auth.purgar" }).success,
    ).toBe(true);
    expect(
      payloadSistemaSchema.safeParse({ tipo: "kek.rotar", desde: "kek-2025" })
        .success,
    ).toBe(true);
  });
});

describe("ColaSistema.programarBuzon", () => {
  it("llama a upsertJobScheduler con id fijo, every 60000 y la plantilla del tick", async () => {
    const c = crearColaSistema({ conexion, prefijo: "p:" });
    expect(typeof c.programarBuzon).toBe("function");
    await c.programarBuzon();
    const q = falso.colas.find((x) => x.nombre === COLA_SISTEMA)!;
    expect(q).toBeDefined();
    expect(q.llamadas).toHaveLength(1);
    const [id, repeticion, plantilla] = q.llamadas[0] as [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(id).toBe("buzon.programar");
    expect(repeticion).toEqual({ every: 60_000 });
    expect(plantilla).toMatchObject({
      name: "buzon.programar",
      data: { tipo: "buzon.programar" },
    });
    expect(plantilla.data).toEqual({ tipo: "buzon.programar" });
    await c.cerrar();
  });

  it("la cola es `programados`", async () => {
    const c = crearColaSistema({ conexion });
    await c.programarBuzon();
    expect(falso.colas.map((q) => q.nombre)).toEqual([COLA_SISTEMA]);
    expect(COLA_SISTEMA).toBe("programados");
  });

  it("dos llamadas (dos workers que arrancan) dejan un solo repetible con el mismo id", async () => {
    const a = crearColaSistema({ conexion });
    const b = crearColaSistema({ conexion });
    await a.programarBuzon();
    await b.programarBuzon();
    await a.programarBuzon();
    const ids = falso.colas.flatMap((q) => q.llamadas.map((l) => l[0]));
    expect(new Set(ids)).toEqual(new Set(["buzon.programar"]));
    expect(ids).toHaveLength(3);
    // BullMQ guarda un repetible por id: aquí, uno por cola simulada, sin ids derivados del proceso.
    for (const q of falso.colas)
      expect(q.repetibles.size).toBeLessThanOrEqual(1);
    await a.cerrar();
    await b.cerrar();
  });

  it("el repetible no lleva secretos, tenant ni cliente en la plantilla", async () => {
    const c = crearColaSistema({ conexion });
    await c.programarBuzon();
    const llamada = JSON.stringify(falso.colas[0]!.llamadas[0]);
    for (const prohibido of ["tenant", "cliente", "clave", "ruc", "token"])
      expect(llamada.toLowerCase()).not.toContain(prohibido);
  });

  it("no registra auth.purgar ni toca su repetible", async () => {
    const c = crearColaSistema({ conexion });
    await c.programarBuzon();
    expect(falso.colas[0]!.llamadas.map((l) => l[0])).not.toContain(
      "auth.purgar",
    );
  });

  it("programarPurga sigue registrando su repetible con el patrón diario", async () => {
    const c = crearColaSistema({ conexion });
    await c.programarPurga();
    const [id, repeticion] = falso.colas[0]!.llamadas[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(id).toBe("auth.purgar");
    expect(repeticion).toMatchObject({
      pattern: "30 3 * * *",
      tz: "America/Lima",
    });
  });
});

describe("ColaSistema.encolar y procesarJobSistema con buzon.programar", () => {
  it("encolar acepta {tipo: buzon.programar} y lo agrega con el tipo como nombre", async () => {
    const c = crearColaSistema({ conexion });
    await c.encolar({ tipo: "buzon.programar" });
    // El tercer elemento son las opciones de trabajo de sistema (removeOnComplete, attempts), como en kek.rotar.
    expect(falso.colas[0]!.agregados[0]).toMatchObject([
      "buzon.programar",
      { tipo: "buzon.programar" },
      expect.anything(),
    ]);
  });

  it("encolar rechaza claves de más sin tocar Redis", async () => {
    const c = crearColaSistema({ conexion });
    await expect(
      c.encolar({ tipo: "buzon.programar", clienteId: "x" } as never),
    ).rejects.toThrow();
    expect(falso.colas.every((q) => q.agregados.length === 0)).toBe(true);
  });

  it("procesarJobSistema entrega el payload válido al procesador", async () => {
    const procesar = vi.fn(async () => undefined);
    await procesarJobSistema({ data: { tipo: "buzon.programar" } }, procesar);
    expect(procesar).toHaveBeenCalledTimes(1);
    expect(procesar).toHaveBeenCalledWith({ tipo: "buzon.programar" });
  });

  it("un job buzon.programar con claves extra o forjado se descarta sin efectos", async () => {
    const procesar = vi.fn(async () => undefined);
    await procesarJobSistema(
      { data: { tipo: "buzon.programar", clienteId: "x" } },
      procesar,
    );
    await procesarJobSistema(
      { data: { tipo: "buzon.programar", desde: "k" } },
      procesar,
    );
    expect(procesar).not.toHaveBeenCalled();
  });
});

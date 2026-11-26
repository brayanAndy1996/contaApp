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

import { COLA_SISTEMA, crearColaSistema, payloadSistemaSchema, procesarJobSistema } from "./index.js";

// Spec 028 · T2 (rojo). Trabajo de sistema `correo.programar` (plan 028, Contratos: Cola; Worker; R-5). Contrato fijado por estas pruebas
// (packages/queue/src/worker/index.ts), igual que `buzon.programar` de 023:
//  - payloadSistemaSchema acepta `{tipo: "correo.programar"}` ESTRICTO (sin `job_registro`); cualquier clave extra se rechaza y los tipos previos
//    (`kek.rotar`, `auth.purgar`, `buzon.programar`) siguen igual.
//  - ColaSistema.programarCorreo() = `upsertJobScheduler("correo.programar", {every: 60_000}, {name: "correo.programar",
//    data: {tipo: "correo.programar"}, opts})` sobre la cola `programados`: id fijo, así que N workers que lo registran dejan UN repetible.
//    El tick solo pide el ciclo; la hora del resumen la decide la BD (R-5), no el worker.
//  - El repetible no lleva credenciales, tenant, usuario ni correo en su `data`. No toca el repetible de `buzon.programar` ni el de `auth.purgar`.
//  - Se exporta CORREO_TICK_MS = 60_000.
const conexion = { host: "localhost", port: 6379 };

// `programarCorreo` aún no existe en ColaSistema (lo agrega T9): se pide por nombre para que el archivo compile y la prueba falle con «no es una función».
type ColaConCorreo = { programarCorreo: () => Promise<void>; encolar: (d: never) => Promise<void>; cerrar: () => Promise<void> };
const nueva = (o: Parameters<typeof crearColaSistema>[0]): ColaConCorreo => crearColaSistema(o) as unknown as ColaConCorreo;

beforeEach(() => {
  falso.colas = [];
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("payloadSistemaSchema: correo.programar", () => {
  it("acepta {tipo: correo.programar} y lo devuelve igual", () => {
    const r = payloadSistemaSchema.safeParse({ tipo: "correo.programar" });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ tipo: "correo.programar" });
  });

  it.each([
    ["usuarioId", { usuarioId: "x" }],
    ["tenantId", { tenantId: "x" }],
    ["para", { para: "ana@estudio.pe" }],
    ["hora", { hora: "07:00" }],
    ["dia", { dia: "2026-11-24" }],
    ["desde", { desde: "k1" }],
    ["constructor", { constructor: 1 }],
  ])("rechaza la clave extra %s", (_c, extra) => {
    expect(payloadSistemaSchema.safeParse({ tipo: "correo.programar", ...extra }).success).toBe(false);
  });

  it.each(["correo.programa", "Correo.programar", "correo.programar ", "correo", "correo.enviar", "", null, 1, undefined])("rechaza el tipo %j", (tipo) => {
    expect(payloadSistemaSchema.safeParse({ tipo }).success).toBe(false);
  });

  it("los tipos de sistema previos siguen aceptados", () => {
    expect(payloadSistemaSchema.safeParse({ tipo: "auth.purgar" }).success).toBe(true);
    expect(payloadSistemaSchema.safeParse({ tipo: "buzon.programar" }).success).toBe(true);
    expect(payloadSistemaSchema.safeParse({ tipo: "kek.rotar", desde: "kek-2025" }).success).toBe(true);
  });
});

describe("ColaSistema.programarCorreo", () => {
  it("llama a upsertJobScheduler con id fijo, every 60000 y la plantilla del tick", async () => {
    const c = nueva({ conexion, prefijo: "p:" });
    expect(typeof c.programarCorreo).toBe("function");
    await c.programarCorreo();
    const q = falso.colas.find((x) => x.nombre === COLA_SISTEMA)!;
    expect(q).toBeDefined();
    expect(q.llamadas).toHaveLength(1);
    const [id, repeticion, plantilla] = q.llamadas[0] as [string, Record<string, unknown>, Record<string, unknown>];
    expect(id).toBe("correo.programar");
    expect(repeticion).toEqual({ every: 60_000 });
    expect(plantilla).toMatchObject({ name: "correo.programar", data: { tipo: "correo.programar" } });
    expect(plantilla.data).toEqual({ tipo: "correo.programar" });
    await c.cerrar();
  });

  it("CORREO_TICK_MS es 60000", async () => {
    const m = (await import("./index.js")) as Record<string, unknown>;
    expect(m.CORREO_TICK_MS).toBe(60_000);
  });

  it("la cola es `programados`", async () => {
    const c = nueva({ conexion });
    await c.programarCorreo();
    expect(falso.colas.map((q) => q.nombre)).toEqual([COLA_SISTEMA]);
    expect(COLA_SISTEMA).toBe("programados");
  });

  it("es idempotente: dos workers y una repetición dejan el mismo id", async () => {
    const a = nueva({ conexion });
    const b = nueva({ conexion });
    await a.programarCorreo();
    await b.programarCorreo();
    await a.programarCorreo();
    const ids = falso.colas.flatMap((q) => q.llamadas.map((l) => l[0]));
    expect(new Set(ids)).toEqual(new Set(["correo.programar"]));
    expect(ids).toHaveLength(3);
    for (const q of falso.colas) expect(q.repetibles.size).toBeLessThanOrEqual(1);
    await a.cerrar();
    await b.cerrar();
  });

  it("el repetible no lleva secretos, tenant, usuario ni correo en la plantilla", async () => {
    const c = nueva({ conexion });
    await c.programarCorreo();
    const llamada = JSON.stringify(falso.colas[0]!.llamadas[0]);
    for (const prohibido of ["tenant", "usuario", "cliente", "clave", "ruc", "token", "@"]) expect(llamada.toLowerCase()).not.toContain(prohibido);
  });

  it("no toca los repetibles de auth.purgar ni de buzon.programar", async () => {
    const c = nueva({ conexion });
    await c.programarCorreo();
    const ids = falso.colas[0]!.llamadas.map((l) => l[0]);
    expect(ids).not.toContain("auth.purgar");
    expect(ids).not.toContain("buzon.programar");
  });

  it("programarBuzon y programarPurga siguen igual", async () => {
    const c = nueva({ conexion });
    await (c as unknown as { programarBuzon: () => Promise<void> }).programarBuzon();
    await (c as unknown as { programarPurga: () => Promise<void> }).programarPurga();
    const llamadas = falso.colas[0]!.llamadas as [string, Record<string, unknown>][];
    expect(llamadas[0]![0]).toBe("buzon.programar");
    expect(llamadas[0]![1]).toEqual({ every: 60_000 });
    expect(llamadas[1]![0]).toBe("auth.purgar");
    expect(llamadas[1]![1]).toMatchObject({ pattern: "30 3 * * *", tz: "America/Lima" });
  });
});

describe("ColaSistema.encolar y procesarJobSistema con correo.programar", () => {
  it("encolar acepta {tipo: correo.programar} y lo agrega con el tipo como nombre", async () => {
    const c = nueva({ conexion });
    await c.encolar({ tipo: "correo.programar" } as never);
    expect(falso.colas[0]!.agregados[0]).toMatchObject(["correo.programar", { tipo: "correo.programar" }, expect.anything()]);
  });

  it("encolar rechaza claves de más sin tocar Redis", async () => {
    const c = nueva({ conexion });
    await expect(c.encolar({ tipo: "correo.programar", usuarioId: "x" } as never)).rejects.toThrow();
    expect(falso.colas.every((q) => q.agregados.length === 0)).toBe(true);
  });

  it("procesarJobSistema entrega el payload válido al procesador", async () => {
    const procesar = vi.fn(async () => undefined);
    await procesarJobSistema({ data: { tipo: "correo.programar" } }, procesar);
    expect(procesar).toHaveBeenCalledTimes(1);
    expect(procesar).toHaveBeenCalledWith({ tipo: "correo.programar" });
  });

  it("un job correo.programar con claves extra o forjado se descarta sin efectos", async () => {
    const procesar = vi.fn(async () => undefined);
    await procesarJobSistema({ data: { tipo: "correo.programar", usuarioId: "x" } }, procesar);
    await procesarJobSistema({ data: { tipo: "correo.programar", desde: "k" } }, procesar);
    expect(procesar).not.toHaveBeenCalled();
  });
});

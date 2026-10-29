// Unitarias del ensamblado `iniciarTrabajos` (T10): cableado, trabajos de sistema, cierre ordenado con tiempo
// agotado y muerte. BullMQ, despachador, reconciliador, ejecutor y caché de token son dobles; la integración real está
// en *.int.spec.ts (T5).
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  workers: [] as Array<{
    colas: unknown;
    procesar: (c: string, p: unknown) => Promise<void>;
    cerrar: ReturnType<typeof vi.fn>;
    ajustar: ReturnType<typeof vi.fn>;
  }>,
  sistema: {
    encolar: vi.fn(),
    programarPurga: vi.fn(async () => undefined),
    cerrar: vi.fn(async () => undefined),
  },
  workerSistema: {
    procesar: null as null | ((d: unknown) => Promise<void>),
    cerrar: vi.fn(async () => undefined),
  },
  colas: {
    agregarACola: vi.fn(async () => undefined),
    cerrar: vi.fn(async () => undefined),
  },
  despachador: {
    opciones: null as null | {
      agregarACola: (c: string, p: unknown) => Promise<void>;
    },
    ciclos: 0,
    fallar: false,
  },
  reconciliador: {
    opciones: null as null | Record<string, unknown>,
    ciclos: 0,
  },
  ejecutor: {
    deps: null as null | {
      procesadores: Record<string, (c: unknown) => Promise<unknown>>;
    },
    ejecutar: vi.fn(async () => undefined),
    esperar: vi.fn(async () => true),
    soltarEnCurso: vi.fn(async () => undefined),
    abandonar: vi.fn(),
  },
  cache: {
    opciones: null as null | { credenciales: (c: unknown) => Promise<unknown> },
  },
  servicio: {
    deps: null as null | {
      logger: { log: (e: unknown) => void; warn: (e: unknown) => void };
    },
  },
  authPurgar: vi.fn(async () => ({})),
  kekRotar: vi.fn(async () => ({})),
}));

vi.mock("@contapp/queue/worker", () => ({
  crearColas: () => h.colas,
  crearWorkers: (o: {
    colas: unknown;
    procesar: (c: string, p: unknown) => Promise<void>;
  }) => {
    const w = { ...o, cerrar: vi.fn(async () => undefined), ajustar: vi.fn() };
    h.workers.push(w);
    return { cerrar: w.cerrar, ajustarConcurrencia: w.ajustar };
  },
  crearColaSistema: () => h.sistema,
  crearWorkerSistema: (o: { procesar: (d: unknown) => Promise<void> }) => {
    h.workerSistema.procesar = o.procesar;
    return { cerrar: h.workerSistema.cerrar };
  },
}));
vi.mock("@contapp/queue", async (original) => ({
  ...(await original<typeof import("@contapp/queue")>()),
  Despachador: class {
    constructor(o: { agregarACola: (c: string, p: unknown) => Promise<void> }) {
      h.despachador.opciones = o;
    }
    async ciclo() {
      h.despachador.ciclos += 1;
      if (h.despachador.fallar) throw new Error("ciclo");
    }
  },
  Reconciliador: class {
    constructor(o: Record<string, unknown>) {
      h.reconciliador.opciones = o;
    }
    async ciclo() {
      h.reconciliador.ciclos += 1;
    }
  },
  CacheConfig: class {
    async obtener() {
      return new Map([["sire", { concurrenciaGlobal: 6 }]]);
    }
  },
}));
vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  leerConfig: vi.fn(async () => new Map([["sire", { concurrenciaGlobal: 4 }]])),
}));
vi.mock("./ejecutor.js", () => ({
  Ejecutor: class {
    constructor(d: never) {
      h.ejecutor.deps = d;
    }
    ejecutar = h.ejecutor.ejecutar;
    esperar = h.ejecutor.esperar;
    soltarEnCurso = h.ejecutor.soltarEnCurso;
    abandonar = h.ejecutor.abandonar;
  },
}));
vi.mock("./token-sire/cache-token.js", () => ({
  CacheTokenSire: class {
    constructor(o: never) {
      h.cache.opciones = o;
    }
  },
}));
vi.mock("../credenciales/descifrar-credencial.js", () => ({
  crearServicioCredenciales: (d: never) => {
    h.servicio.deps = d;
    return { descifrarCredencial: vi.fn() };
  },
}));
vi.mock("./procesadores/auth-purgar.js", () => ({ authPurgar: h.authPurgar }));
vi.mock("./procesadores/kek-rotar.js", () => ({ kekRotar: h.kekRotar }));

import { iniciarTrabajos, type DepsTrabajos } from "./iniciar.js";
import type { EventoLog } from "./registro.js";

function deps(extra: Partial<DepsTrabajos> = {}) {
  const logs: EventoLog[] = [];
  const logger = {
    debug: (e: EventoLog) => logs.push(e),
    info: (e: EventoLog) => logs.push(e),
    warn: (e: EventoLog) => logs.push(e),
    error: (e: EventoLog) => logs.push(e),
  };
  const db = {
    withTenant: vi.fn(),
    withSistema: async (fn: (tx: unknown) => unknown) => fn({ query: vi.fn() }),
  };
  const d = {
    db,
    redis: {},
    conexionBull: { host: "h" },
    logger,
    intervalos: { despachadorMs: 5, reconciliadorMs: 5, latidoMs: 5 },
    ...extra,
  } as unknown as DepsTrabajos;
  return { d, logs };
}

beforeEach(() => {
  h.workers = [];
  h.despachador.ciclos = 0;
  h.despachador.fallar = false;
  h.reconciliador.ciclos = 0;
  h.ejecutor.esperar.mockResolvedValue(true);
  vi.clearAllMocks();
});

describe("iniciarTrabajos (unitarias)", () => {
  it("caso feliz: una cola BullMQ por cola configurada, purga programada, bucles en marcha y concurrencia ajustada", async () => {
    const { d, logs } = deps({ antiguedadSeg: 7 });
    const en = await iniciarTrabajos(d);
    expect(h.workers[0]!.colas).toEqual([{ cola: "sire", concurrencia: 4 }]);
    expect(h.sistema.programarPurga).toHaveBeenCalledTimes(1);
    expect(h.reconciliador.opciones).toMatchObject({
      antiguedadSeg: 7,
      prefijo: "contapp:",
    });
    await vi.waitFor(() =>
      expect(h.workers[0]!.ajustar).toHaveBeenCalledWith("sire", 6),
    );
    await vi.waitFor(() => expect(h.reconciliador.ciclos).toBeGreaterThan(0));
    // El worker BullMQ entrega al ejecutor; el despachador agrega por la cola de BullMQ.
    await h.workers[0]!.procesar("sire", { jobId: "j" });
    expect(h.ejecutor.ejecutar).toHaveBeenCalledWith("sire", { jobId: "j" });
    await h.despachador.opciones!.agregarACola("sire", { jobId: "j" });
    expect(h.colas.agregarACola).toHaveBeenCalledWith("sire", { jobId: "j" });
    // `prueba.eco` existe por defecto con NODE_ENV=test y termina bien.
    expect(await h.ejecutor.deps!.procesadores["prueba.eco"]!({})).toEqual({
      ok: true,
    });
    await en.detener();
    await en.detener(); // idempotente
    expect(h.workers[0]!.cerrar).toHaveBeenCalledWith(false);
    expect(h.ejecutor.soltarEnCurso).not.toHaveBeenCalled();
    expect(logs.map((l) => l.evento)).toEqual([
      "trabajos_iniciados",
      "trabajos_detenidos",
    ]);
  });

  it("un ciclo que falla no detiene el bucle", async () => {
    h.despachador.fallar = true;
    const en = await iniciarTrabajos(deps().d);
    await vi.waitFor(() => expect(h.despachador.ciclos).toBeGreaterThan(1));
    await en.detener();
  });

  it("cierre con tiempo agotado: suelta los arriendos de lo que sigue en curso y fuerza el cierre de BullMQ", async () => {
    h.ejecutor.esperar.mockResolvedValue(false);
    const en = await iniciarTrabajos(deps().d);
    await en.detener({ esperaMs: 10 });
    expect(h.ejecutor.soltarEnCurso).toHaveBeenCalledTimes(1);
    expect(h.workers[0]!.cerrar).toHaveBeenCalledWith(true);
  });

  it("abortar: detiene todo sin esperar, abandona lo que está en curso y no permite un cierre posterior", async () => {
    const en = await iniciarTrabajos(deps().d);
    await en.abortar();
    expect(h.ejecutor.abandonar).toHaveBeenCalledTimes(1);
    expect(h.workerSistema.cerrar).toHaveBeenCalledWith(true);
    await en.detener();
    expect(h.ejecutor.esperar).not.toHaveBeenCalled();
  });

  it("trabajos de sistema: auth.purgar, kek.rotar con llaves, kek.rotar sin llaves y fallos registrados con código", async () => {
    const anterior = vi.fn(() => ({ kekId: "k1" }));
    const kek = { activa: { kekId: "k2" }, anterior } as never;
    const { d, logs } = deps({ kek });
    const en = await iniciarTrabajos(d);
    const procesar = h.workerSistema.procesar!;
    await procesar({ tipo: "auth.purgar" });
    expect(h.authPurgar).toHaveBeenCalledTimes(1);
    await procesar({ tipo: "kek.rotar", desde: "k1" });
    expect(anterior).toHaveBeenCalledWith("k1");
    expect(h.kekRotar).toHaveBeenCalledWith(
      expect.objectContaining({ desde: "k1" }),
    );
    h.kekRotar.mockRejectedValueOnce(
      Object.assign(new Error("x"), { codigo: "anterior_no_abre" }),
    );
    await procesar({ tipo: "kek.rotar", desde: "k1" });
    h.authPurgar.mockRejectedValueOnce(new Error("sin código"));
    await procesar({ tipo: "auth.purgar" });
    expect(
      logs
        .filter((l) => l.evento === "trabajo_sistema_fallo")
        .map((l) => l.codigo),
    ).toEqual(["anterior_no_abre", "desconocido"]);
    // El servicio de descifrado por defecto usa la KEK activa y registra solo ids y resultado.
    h.servicio.deps!.logger.log({ credencialId: "c1", resultado: "ok" });
    h.servicio.deps!.logger.warn({
      credencialId: "c1",
      resultado: "llave",
      codigo: "kek_desconocida",
    });
    expect(logs.filter((l) => l.evento.startsWith("credencial_"))).toEqual([
      { evento: "credencial_descifrada", credencial_id: "c1", resultado: "ok" },
      {
        evento: "credencial_no_descifrada",
        credencial_id: "c1",
        resultado: "llave",
        codigo: "kek_desconocida",
      },
    ]);
    await en.detener();

    const sinLlaves = deps();
    const en2 = await iniciarTrabajos(sinLlaves.d);
    await h.workerSistema.procesar!({ tipo: "kek.rotar", desde: "k1" });
    expect(
      sinLlaves.logs.some((l) => l.evento === "kek_rotar_sin_llaves"),
    ).toBe(true);
    // Sin llaves ni credenciales inyectadas no hay cómo descifrar credenciales SIRE.
    await expect(h.cache.opciones!.credenciales({})).rejects.toMatchObject({
      codigo: "credenciales_sire_no_configuradas",
    });
    await en2.detener();
  });
});

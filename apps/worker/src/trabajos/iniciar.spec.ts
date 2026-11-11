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
      notificador?: unknown;
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
  xml: { deps: null as null | Record<string, unknown> },
  crearStorage: vi.fn(),
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
// T17a: el procesador de XML se reemplaza por un doble que captura sus dependencias (el cableado, no su lógica).
vi.mock("./procesadores/obtener-xml.js", () => ({
  obtenerXml: (d: Record<string, unknown>) => {
    h.xml.deps = d;
    return async () => ({});
  },
}));
vi.mock("@contapp/storage", async (original) => ({
  ...(await original<typeof import("@contapp/storage")>()),
  crearStorage: (env: unknown) => h.crearStorage(env),
}));

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

  // Spec 017 · T4 (rojo): el notificador por defecto es el adaptador Redis (`NotificadorEventos`), no el log.
  it("017: sin `notificador`, el ejecutor avisa por el Redis y el prefijo de las colas (eventos:{tenant})", async () => {
    const publish = vi.fn(async () => 1);
    const T = "0190a000-0000-7000-8000-0000000000a1";
    const U = "0190a000-0000-7000-8000-0000000000b1";
    const { d } = deps({ redis: { publish } as never, prefijo: "t17i:" });
    const en = await iniciarTrabajos(d);
    const notificador = h.ejecutor.deps!.notificador as {
      avisar(t: string, u: string[]): Promise<void>;
      credencialInvalida?: unknown;
    };
    expect(typeof notificador.avisar).toBe("function");
    expect(
      notificador.credencialInvalida,
      "NotificadorLog ya no es el por defecto",
    ).toBeUndefined();
    await notificador.avisar(T, [U]);
    expect(publish).toHaveBeenCalledTimes(1);
    const [canal, texto] = publish.mock.calls[0] as unknown as [string, string];
    expect(canal).toBe(`t17i:eventos:${T}`);
    expect(JSON.parse(texto)).toEqual({
      evento: "notificacion",
      destinatarios: [U],
    });
    await en.detener();
  });

  it("017: un `notificador` inyectado se respeta", async () => {
    const notificador = { avisar: vi.fn(async () => undefined) };
    const en = await iniciarTrabajos(deps({ notificador }).d);
    expect(h.ejecutor.deps!.notificador).toBe(notificador);
    await en.detener();
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

  it("T17a · si el proveedor se cuelga al soltar los arriendos, el cierre igual termina y fuerza BullMQ", async () => {
    h.ejecutor.esperar.mockResolvedValue(false);
    h.ejecutor.soltarEnCurso.mockRejectedValueOnce(new Error("redis caído"));
    const { d, logs } = deps();
    const en = await iniciarTrabajos(d);
    await expect(en.detener({ esperaMs: 10 })).resolves.toBeUndefined();
    expect(h.ejecutor.soltarEnCurso).toHaveBeenCalledTimes(1);
    expect(h.workers[0]!.cerrar).toHaveBeenCalledWith(true);
    expect(logs.map((l) => l.evento)).toContain("trabajos_detenidos");
  });

  it("T17a · sin trabajos en curso pero con BullMQ que no cierra a tiempo: fuerza el cierre y el proceso deja de escribir", async () => {
    const { d, logs } = deps();
    const en = await iniciarTrabajos(d);
    // Redis caído: el cierre ordenado de BullMQ no vuelve; solo el forzado termina.
    h.workers[0]!.cerrar.mockImplementation((forzar: boolean) =>
      forzar ? Promise.resolve() : new Promise<void>(() => undefined),
    );
    const bd = (
      h.ejecutor.deps as unknown as {
        db: {
          withTenant: (
            c: unknown,
            f: (tx: unknown) => unknown,
          ) => Promise<unknown>;
        };
      }
    ).db;
    // Vivo: pasa a la BD de la prueba (un vi.fn que no devuelve promesa).
    expect(bd.withTenant({}, async () => "ok")).toBeUndefined();
    await en.detener({ esperaMs: 40 });
    expect(h.workers[0]!.cerrar.mock.calls.map((c) => c[0])).toEqual([
      false,
      true,
    ]);
    expect(h.ejecutor.soltarEnCurso).not.toHaveBeenCalled();
    await expect(bd.withTenant({}, async () => "ok")).rejects.toMatchObject({
      codigo: "proceso_detenido",
    });
    expect(logs.map((l) => l.evento)).toContain("trabajos_detenidos");
  });

  it("T17a · xml.obtener: proveedor mock, bandera del simulado apagada por defecto y storage creado solo al primer uso", async () => {
    h.crearStorage.mockReturnValue({
      guardar: vi.fn(async () => undefined),
      leer: vi.fn(async () => new Uint8Array([1, 2])),
      eliminar: vi.fn(async () => undefined),
    });
    const en = await iniciarTrabajos(deps().d);
    const x = h.xml.deps as {
      xmlProvider: { constructor: { name: string } };
      xmlSimuladoEnReglas: boolean;
      storage: {
        guardar: (r: string, b: Uint8Array) => Promise<void>;
        leer: (r: string) => Promise<Uint8Array>;
        eliminar: (r: string) => Promise<void>;
      };
    };
    expect(x.xmlProvider.constructor.name).toBe("MockXmlProvider");
    expect(x.xmlSimuladoEnReglas).toBe(false);
    // Un worker sin XML no exige configurar el storage: no se crea al arrancar.
    expect(h.crearStorage).not.toHaveBeenCalled();

    const bytes = new Uint8Array([9]);
    await x.storage.guardar("xml/a.xml", bytes);
    await expect(x.storage.leer("xml/a.xml")).resolves.toEqual(
      new Uint8Array([1, 2]),
    );
    await x.storage.eliminar("xml/a.xml");
    expect(h.crearStorage).toHaveBeenCalledTimes(1);
    const real = h.crearStorage.mock.results[0]!.value as Record<
      "guardar" | "leer" | "eliminar",
      ReturnType<typeof vi.fn>
    >;
    expect(real.guardar).toHaveBeenCalledWith("xml/a.xml", bytes);
    expect(real.leer).toHaveBeenCalledWith("xml/a.xml");
    expect(real.eliminar).toHaveBeenCalledWith("xml/a.xml");
    await en.detener();
  });

  it("T17a · xml.obtener: usa el proveedor, el storage y la bandera que se le inyectan", async () => {
    const xmlProvider = { obtener: vi.fn() };
    const storage = { guardar: vi.fn(), leer: vi.fn(), eliminar: vi.fn() };
    const en = await iniciarTrabajos(
      deps({ xmlProvider, storage, xmlSimuladoEnReglas: true } as never).d,
    );
    expect(h.xml.deps).toMatchObject({
      xmlProvider,
      storage,
      xmlSimuladoEnReglas: true,
    });
    expect(h.crearStorage).not.toHaveBeenCalled();
    await en.detener();
  });
});

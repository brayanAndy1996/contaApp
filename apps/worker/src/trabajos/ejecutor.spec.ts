// Unitarias del ejecutor (T10): ramas que la integración de T5 no alcanza (tipo sin definición o sin procesador,
// arriendo ocupado, transición perdida, fallo de la transacción final, cierre con tiempo agotado). BD y arriendos
// dobles; clasificación y decisión reales.
// Spec 017 · T4 (rojo): el puerto es `Notificador.avisar(tenantId, usuarioIds)`. Contrato que fijan las pruebas del final (T9):
//  - `transicionFinal` lee `destinatariosNuevos(tx)` (de @contapp/db) en la MISMA transacción de la transición terminal, antes del
//    commit, y el ejecutor llama `notificador.avisar(tenantId, destinatarios)` DESPUÉS del commit, sin esperarlo y solo si hay.
//  - Todo `withTenant` de cierre del trabajo lleva `{ tenantId, trabajoId: fila.id }` (el actor `trabajo` de la auditoría sale de ahí).
//  - Un fallo del Notificador (rechazo, excepción o aviso colgado) solo se registra con códigos: el trabajo ya está cerrado.
import type { TrabajoFila } from "@contapp/db";
import { ErrorCredencial, ErrorTransitorio } from "@contapp/sunat";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  filas: new Map<string, Record<string, unknown>>(),
  transicionar: [] as unknown[][],
  fallarTransicion: 0,
  perderTransicion: false,
  perderLectura: false,
  // 017
  destinatarios: [] as string[],
  orden: [] as string[],
  txs: 0,
  txActual: null as unknown,
  ctxActual: null as unknown,
  txDeTransicion: [] as unknown[],
  ctxDeTransicion: [] as unknown[],
  txDeDestinatarios: [] as unknown[],
}));
const q = vi.hoisted(() => ({
  ejecucionLibre: true,
  liberados: [] as unknown[][],
  publicados: [] as unknown[],
  eventos: [] as unknown[],
  latidos: [] as Array<() => Promise<unknown>>,
  detenidos: 0,
  acortados: 0,
}));

vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  leerTrabajo: vi.fn(async (_tx: unknown, id: string) => {
    if (db.perderLectura && db.transicionar.length > 0) return null;
    const f = db.filas.get(id);
    return f === undefined ? null : { ...f };
  }),
  transicionar: vi.fn(
    async (
      _tx: unknown,
      id: string,
      desde: string,
      hacia: string,
      campos: Record<string, unknown>,
    ) => {
      db.transicionar.push([id, desde, hacia, campos]);
      db.orden.push("transicionar");
      db.txDeTransicion.push(db.txActual);
      db.ctxDeTransicion.push(db.ctxActual);
      if (db.fallarTransicion > 0) {
        db.fallarTransicion -= 1;
        throw new Error("check violation");
      }
      if (db.perderTransicion) return false;
      const f = db.filas.get(id)!;
      Object.assign(f, { estado: hacia, ...campos });
      return true;
    },
  ),
  marcarCredencialInvalida: vi.fn(async () => true),
  destinatariosNuevos: vi.fn(async (tx: unknown) => {
    db.orden.push("destinatarios");
    db.txDeDestinatarios.push(tx);
    return [...db.destinatarios];
  }),
}));

vi.mock("@contapp/queue", async (original) => ({
  ...(await original<typeof import("@contapp/queue")>()),
  tomarEjecucion: vi.fn(async () => q.ejecucionLibre),
  renovarArriendos: vi.fn(async () => true),
  soltarLockRuc: vi.fn(async () => {
    q.acortados += 1;
  }),
  liberarArriendos: vi.fn(async (...a: unknown[]) => {
    q.liberados.push(a);
  }),
  publicar: vi.fn(async (_r: unknown, t: unknown) => {
    q.publicados.push(t);
  }),
  publicarEvento: vi.fn(async (_r: unknown, _t: unknown, e: unknown) => {
    q.eventos.push(e);
  }),
  iniciarLatido: vi.fn((renovar: () => Promise<unknown>) => {
    q.latidos.push(renovar);
    return () => {
      q.detenidos += 1;
    };
  }),
}));

import { registrarTipo, type CacheConfig } from "@contapp/queue";
import { z } from "zod";
import { Ejecutor, type Procesador } from "./ejecutor.js";
import type { EventoLog } from "./registro.js";

const T = "0190a000-0000-7000-8000-0000000000a1";
const C = "0190a000-0000-7000-8000-0000000000c1";
let n = 0;

registrarTipo({
  tipo: "unit.eco",
  cola: "sire",
  canal: "sire",
  credencial: "sol",
  permiso: null,
  idempotente: true,
  parametros: z.object({}),
});

function fila(o: Partial<TrabajoFila> = {}): TrabajoFila {
  const id = `0190a000-0000-7000-8000-${String(++n).padStart(12, "0")}`;
  const f = {
    id,
    tenantId: T,
    clienteId: C,
    ruc: "20100070970",
    tipo: "unit.eco",
    cola: "sire",
    canal: "sire",
    prioridad: "interactivo",
    estado: "ejecutando",
    parametros: {},
    claveDedupe: Buffer.alloc(32),
    creadoPor: null,
    intentos: 0,
    maxIntentos: 4,
    motivo: null,
    resultado: null,
    disponibleDesde: new Date(),
    creadoEn: new Date(),
    iniciadoEn: new Date(),
    terminadoEn: null,
    actualizadoEn: new Date(),
    ...o,
  } as TrabajoFila;
  db.filas.set(f.id, f as unknown as Record<string, unknown>);
  return f;
}

const config = (
  m: Map<string, unknown> = new Map([
    ["sire", { reintentos: 2, backoffBaseMs: 100, esperaRucMs: 50 }],
  ]),
) => ({ obtener: async () => m }) as unknown as CacheConfig;

function ejecutor(
  o: {
    procesadores?: Record<string, Procesador>;
    config?: CacheConfig;
    notificador?: () => Promise<void> | void;
  } = {},
) {
  const logs: Array<{ nivel: string; e: EventoLog }> = [];
  const logger = {
    info: (e: EventoLog) => logs.push({ nivel: "info", e }),
    warn: (e: EventoLog) => logs.push({ nivel: "warn", e }),
    error: (e: EventoLog) => logs.push({ nivel: "error", e }),
  };
  const notificador = {
    avisar: vi.fn(async (...a: unknown[]) => {
      void a;
      db.orden.push("aviso");
      await (o.notificador ?? (async () => undefined))();
    }),
  };
  const ex = new Ejecutor({
    db: {
      withTenant: async (c: unknown, fn: (t: unknown) => unknown) => {
        const tx = { query: vi.fn(), n: ++db.txs };
        db.txActual = tx;
        db.ctxActual = c;
        const r = await fn(tx);
        db.orden.push("commit");
        return r;
      },
      withSistema: async () => undefined,
    } as never,
    redis: {} as never,
    reloj: { ahora: () => new Date() },
    procesadores: o.procesadores ?? { "unit.eco": async () => undefined },
    config: o.config ?? config(),
    tokens: { conToken: async (_c, usar) => usar("tk") },
    notificador,
    logger,
    latidoMs: 10,
  });
  return { ex, logs, notificador, eventos: () => logs.map((l) => l.e.evento) };
}

const payload = (f: TrabajoFila) => ({
  jobId: f.id,
  tenantId: f.tenantId,
  tipo: f.tipo,
});

beforeEach(() => {
  db.filas.clear();
  db.transicionar = [];
  db.fallarTransicion = 0;
  db.perderTransicion = false;
  db.perderLectura = false;
  Object.assign(db, {
    destinatarios: [],
    orden: [],
    txs: 0,
    txActual: null,
    ctxActual: null,
    txDeTransicion: [],
    ctxDeTransicion: [],
    txDeDestinatarios: [],
  });
  Object.assign(q, {
    ejecucionLibre: true,
    liberados: [],
    publicados: [],
    eventos: [],
    latidos: [],
    detenidos: 0,
    acortados: 0,
  });
});

describe("Ejecutor (unitarias)", () => {
  it("caso feliz: un procesador sin valor guarda resultado null, renueva con el latido y libera con espera_ruc_ms", async () => {
    const f = fila();
    const { ex, eventos } = ejecutor({
      procesadores: {
        "unit.eco": async (ctx) => {
          await q.latidos[0]!();
          expect(await ctx.conToken(async (t) => t)).toBe("tk");
          return undefined;
        },
      },
    });
    await ex.ejecutar("sire", payload(f));
    expect(db.transicionar[0]).toEqual([
      f.id,
      "ejecutando",
      "completado",
      { resultado: null },
    ]);
    expect(q.liberados[0]![3]).toBe(50);
    expect(q.acortados, "el lock pasa a la espera antes del commit").toBe(1);
    expect(q.detenidos).toBe(1);
    expect(eventos()).toEqual(["trabajo_iniciado", "trabajo_completado"]);
    expect(q.eventos).toHaveLength(1);
  });

  it("si otro ejecutor tiene el arriendo, termina sin procesar ni escribir", async () => {
    q.ejecucionLibre = false;
    const f = fila();
    const proc = vi.fn(async () => ({}));
    const { ex, eventos } = ejecutor({ procesadores: { "unit.eco": proc } });
    await ex.ejecutar("sire", payload(f));
    expect(proc).not.toHaveBeenCalled();
    expect(db.transicionar).toHaveLength(0);
    expect(eventos()).toEqual(["trabajo_ya_en_curso"]);
  });

  it("payload de otra cola: sin efectos", async () => {
    const f = fila();
    const { ex, eventos } = ejecutor();
    await ex.ejecutar("sol", payload(f));
    expect(db.transicionar).toHaveLength(0);
    expect(eventos()).toEqual(["trabajo_descartado"]);
  });

  it("un tipo sin definición o sin procesador termina en error/error_interno", async () => {
    const sinDef = fila({ tipo: "unit.fantasma" });
    const sinProc = fila();
    const { ex, logs } = ejecutor({ procesadores: {} });
    await ex.ejecutar("sire", payload(sinDef));
    await ex.ejecutar("sire", payload(sinProc));
    expect(
      db.transicionar.map((t) => [t[2], (t[3] as { motivo?: string }).motivo]),
    ).toEqual([
      ["error", "error_interno"],
      ["error", "error_interno"],
    ]);
    expect(
      logs.filter((l) => l.e.evento === "trabajo_error").map((l) => l.e.codigo),
    ).toEqual(["error_interno", "error_interno"]);
  });

  it("sin configuración de la cola usa la mínima: sin reintentos ni espera", async () => {
    const f = fila();
    const { ex } = ejecutor({
      config: config(new Map()),
      procesadores: {
        "unit.eco": async () => {
          throw new ErrorTransitorio();
        },
      },
    });
    await ex.ejecutar("sire", payload(f));
    expect(db.transicionar[0]!.slice(2)).toEqual([
      "error",
      { motivo: "sunat_no_responde" },
    ]);
    expect(q.liberados[0]![3]).toBe(0);
    expect(
      q.acortados,
      "con espera 0 el lock se conserva hasta el commit",
    ).toBe(0);
  });

  it("si la transacción final falla, deja el trabajo en error/error_interno", async () => {
    db.fallarTransicion = 1;
    const f = fila();
    const { ex } = ejecutor({
      procesadores: { "unit.eco": async () => ({ grande: true }) },
    });
    await ex.ejecutar("sire", payload(f));
    expect(db.transicionar.map((t) => t[2])).toEqual(["completado", "error"]);
    expect(db.filas.get(f.id)).toMatchObject({
      estado: "error",
      motivo: "error_interno",
    });
  });

  it("si tampoco se puede escribir error_interno, suelta los arriendos y lo registra sin datos", async () => {
    db.fallarTransicion = 2;
    const f = fila();
    const { ex, logs } = ejecutor();
    await ex.ejecutar("sire", payload(f));
    expect(q.liberados).toHaveLength(1);
    expect(logs.at(-1)).toEqual({
      nivel: "error",
      e: {
        evento: "trabajo_fallo_interno",
        tenant_id: T,
        job_id: f.id,
        tipo: "unit.eco",
      },
    });
    expect(q.eventos).toHaveLength(0);
  });

  it("un error_interno que no se puede escribir no se reintenta en bucle", async () => {
    db.fallarTransicion = 1;
    const f = fila({ tipo: "unit.fantasma" });
    const { ex, eventos } = ejecutor();
    await ex.ejecutar("sire", payload(f));
    expect(db.transicionar).toHaveLength(1);
    expect(eventos().at(-1)).toBe("trabajo_fallo_interno");
  });

  it("transición perdida (otro actor movió el trabajo): no libera arriendos ni publica", async () => {
    db.perderTransicion = true;
    const f = fila();
    const { ex, eventos } = ejecutor();
    await ex.ejecutar("sire", payload(f));
    expect(q.liberados).toHaveLength(0);
    expect(q.eventos).toHaveLength(0);
    expect(eventos().at(-1)).toBe("trabajo_transicion_perdida");
  });

  it("la fila desaparece tras la transición: se trata como perdida", async () => {
    db.perderLectura = true;
    const f = fila();
    const { ex, eventos } = ejecutor();
    await ex.ejecutar("sire", payload(f));
    expect(eventos().at(-1)).toBe("trabajo_transicion_perdida");
  });

  it("un error terminal sin motivo en la fila se registra como error_interno", async () => {
    const f = fila();
    const { ex, logs } = ejecutor({
      procesadores: {
        "unit.eco": async () => {
          db.filas.get(f.id)!.motivo = null;
          throw new ErrorTransitorio();
        },
      },
      config: config(
        new Map([
          ["sire", { reintentos: 0, backoffBaseMs: 100, esperaRucMs: 0 }],
        ]),
      ),
    });
    // La transición escribe el motivo; se borra después para simular una fila sin motivo.
    const { transicionar } = await import("@contapp/db");
    vi.mocked(transicionar).mockImplementationOnce(
      async (_tx, id, _d, hacia) => {
        Object.assign(db.filas.get(id)!, { estado: hacia, motivo: null });
        return true;
      },
    );
    await ex.ejecutar("sire", payload(f));
    expect(logs.find((l) => l.e.evento === "trabajo_error")?.e.codigo).toBe(
      "error_interno",
    );
  });

  it("esperar() devuelve false si un trabajo sigue en curso; soltarEnCurso libera sus arriendos y lo abandona", async () => {
    const f = fila();
    let soltar!: () => void;
    const puerta = new Promise<void>((r) => (soltar = r));
    const { ex } = ejecutor({
      procesadores: { "unit.eco": () => puerta.then(() => ({})) },
    });
    const corriendo = ex.ejecutar("sire", payload(f));
    await vi.waitFor(() => expect(q.latidos).toHaveLength(1));
    expect(await ex.esperar(20)).toBe(false);
    await ex.soltarEnCurso();
    expect(q.liberados).toHaveLength(1);
    soltar();
    await corriendo;
    expect(db.transicionar, "abandonado: sin efectos al terminar").toHaveLength(
      0,
    );
    expect(await ex.esperar(20)).toBe(true);
  });

  it("abandonar() (muerte) detiene los latidos sin liberar nada", async () => {
    const f = fila();
    let soltar!: () => void;
    const puerta = new Promise<void>((r) => (soltar = r));
    const { ex } = ejecutor({
      procesadores: { "unit.eco": () => puerta.then(() => ({})) },
    });
    const corriendo = ex.ejecutar("sire", payload(f));
    await vi.waitFor(() => expect(q.latidos).toHaveLength(1));
    ex.abandonar();
    soltar();
    await corriendo;
    expect(q.liberados).toHaveLength(0);
    expect(db.transicionar).toHaveLength(0);
  });

  it("si liberar los arriendos falla al soltar, sigue con los demás (vencen solos)", async () => {
    const { liberarArriendos } = await import("@contapp/queue");
    vi.mocked(liberarArriendos).mockRejectedValueOnce(new Error("redis caído"));
    const f = fila();
    let soltar!: () => void;
    const puerta = new Promise<void>((r) => (soltar = r));
    const { ex } = ejecutor({
      procesadores: { "unit.eco": () => puerta.then(() => ({})) },
    });
    const corriendo = ex.ejecutar("sire", payload(f));
    await vi.waitFor(() => expect(q.latidos).toHaveLength(1));
    await expect(ex.soltarEnCurso()).resolves.toBeUndefined();
    soltar();
    await corriendo;
  });

  // ---- Spec 017 · T4 --------------------------------------------------------------------------------------------------
  const U1 = "0190a000-0000-7000-8000-0000000000b1";
  const U2 = "0190a000-0000-7000-8000-0000000000b2";

  it("D-9: lee destinatariosNuevos en la transacción de la transición, antes del commit, y avisa después con (tenantId, destinatarios)", async () => {
    db.destinatarios = [U1, U2];
    const f = fila();
    const { ex, notificador } = ejecutor();
    await ex.ejecutar("sire", payload(f));
    expect(notificador.avisar).toHaveBeenCalledTimes(1);
    expect(notificador.avisar.mock.calls[0], "solo dos argumentos").toEqual([
      T,
      [U1, U2],
    ]);
    expect(db.txDeDestinatarios).toHaveLength(1);
    expect(db.txDeDestinatarios[0], "misma transacción que la transición").toBe(
      db.txDeTransicion[0],
    );
    const o = db.orden;
    const iTransicion = o.indexOf("transicionar");
    const iDest = o.indexOf("destinatarios");
    const iCommit = o.indexOf("commit", iDest);
    const iAviso = o.indexOf("aviso");
    expect(iTransicion).toBeGreaterThan(-1);
    expect(iDest).toBeGreaterThan(iTransicion);
    expect(iCommit).toBeGreaterThan(iDest);
    expect(iAviso, "el aviso sale tras el commit").toBeGreaterThan(iCommit);
  });

  it("avisa también al terminar en error (con un ErrorCredencial el aviso lleva a los destinatarios de ambas notificaciones)", async () => {
    db.destinatarios = [U1];
    const f = fila();
    const { ex, notificador } = ejecutor({
      procesadores: {
        "unit.eco": async () => {
          throw new ErrorCredencial();
        },
      },
    });
    await ex.ejecutar("sire", payload(f));
    const { marcarCredencialInvalida } = await import("@contapp/db");
    expect(marcarCredencialInvalida).toHaveBeenCalledTimes(1);
    expect(notificador.avisar).toHaveBeenCalledTimes(1);
    expect(notificador.avisar.mock.calls[0]).toEqual([T, [U1]]);
    expect(db.filas.get(f.id)).toMatchObject({
      estado: "error",
      motivo: "credencial_invalida",
    });
  });

  it("sin destinatarios nuevos no avisa (programado, sin creador o reintento)", async () => {
    db.destinatarios = [];
    const f = fila();
    const { ex, notificador } = ejecutor();
    await ex.ejecutar("sire", payload(f));
    expect(db.txDeDestinatarios).toHaveLength(1);
    expect(notificador.avisar).not.toHaveBeenCalled();
  });

  it("un reintento (en_cola) lee los destinatarios en la transacción pero no avisa si no hay", async () => {
    const f = fila();
    const { ex, notificador } = ejecutor({
      procesadores: {
        "unit.eco": async () => {
          throw new ErrorTransitorio();
        },
      },
    });
    await ex.ejecutar("sire", payload(f));
    expect(db.filas.get(f.id)).toMatchObject({ estado: "en_cola" });
    expect(notificador.avisar).not.toHaveBeenCalled();
  });

  it("transición perdida: no avisa", async () => {
    db.perderTransicion = true;
    db.destinatarios = [U1];
    const f = fila();
    const { ex, notificador } = ejecutor();
    await ex.ejecutar("sire", payload(f));
    expect(notificador.avisar).not.toHaveBeenCalled();
  });

  it("si la transición falla y se reescribe como error_interno, avisa una sola vez, con la segunda transacción", async () => {
    db.fallarTransicion = 1;
    db.destinatarios = [U1];
    const f = fila();
    const { ex, notificador } = ejecutor();
    await ex.ejecutar("sire", payload(f));
    expect(db.transicionar.map((t) => t[2])).toEqual(["completado", "error"]);
    expect(notificador.avisar).toHaveBeenCalledTimes(1);
    expect(db.txDeDestinatarios.at(-1)).toBe(db.txDeTransicion.at(-1));
  });

  it("cada transacción de cierre del trabajo lleva su trabajoId (actor `trabajo` de la auditoría, CA-4)", async () => {
    db.fallarTransicion = 1; // primer intento y reescritura como error_interno: ambas con el trabajoId
    const f = fila();
    const { ex } = ejecutor();
    await ex.ejecutar("sire", payload(f));
    expect(db.ctxDeTransicion).toHaveLength(2);
    for (const c of db.ctxDeTransicion)
      expect(c).toEqual({ tenantId: T, trabajoId: f.id });
  });

  it.each([
    ["rechaza", async () => Promise.reject(new Error("canal caído CANARIO-N"))],
    [
      "lanza en el acto",
      () => {
        throw new Error("canal caído CANARIO-N");
      },
    ],
  ])(
    "si el Notificador %s, solo se registra con códigos y el trabajo ya cerrado sigue su curso (arriendos y evento)",
    async (_n, falla) => {
      db.destinatarios = [U1];
      const f = fila();
      const { ex, logs, notificador } = ejecutor({
        notificador: falla as () => Promise<void>,
      });
      await ex.ejecutar("sire", payload(f));
      expect(notificador.avisar).toHaveBeenCalledTimes(1);
      await vi.waitFor(() =>
        expect(logs.some((l) => l.e.evento === "notificador_fallo")).toBe(true),
      );
      const fallo = logs.find((l) => l.e.evento === "notificador_fallo")!.e;
      expect(fallo).toMatchObject({
        tenant_id: T,
        job_id: f.id,
        tipo: "unit.eco",
      });
      expect(
        JSON.stringify(logs),
        "CA-6: ni el mensaje ni la causa",
      ).not.toContain("CANARIO-N");
      expect(db.filas.get(f.id)).toMatchObject({ estado: "completado" });
      expect(q.liberados).toHaveLength(1);
      expect(q.eventos).toHaveLength(1);
    },
  );

  it("no espera al Notificador: un aviso colgado no retiene el cierre del trabajo", async () => {
    db.destinatarios = [U1];
    const f = fila();
    const { ex } = ejecutor({
      notificador: () => new Promise<void>(() => undefined),
    });
    await ex.ejecutar("sire", payload(f));
    expect(db.filas.get(f.id)).toMatchObject({ estado: "completado" });
    expect(q.liberados).toHaveLength(1);
    expect(q.eventos).toHaveLength(1);
  });

  it("el puerto antiguo `credencialInvalida` ya no se usa", async () => {
    db.destinatarios = [U1];
    const f = fila();
    const { ex, notificador } = ejecutor({
      procesadores: {
        "unit.eco": async () => {
          throw new ErrorCredencial();
        },
      },
    });
    (notificador as unknown as Record<string, unknown>).credencialInvalida =
      vi.fn();
    await ex.ejecutar("sire", payload(f));
    expect(
      (
        notificador as unknown as {
          credencialInvalida: ReturnType<typeof vi.fn>;
        }
      ).credencialInvalida,
    ).not.toHaveBeenCalled();
    expect(notificador.avisar).toHaveBeenCalledTimes(1);
  });
});

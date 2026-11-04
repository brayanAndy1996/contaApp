// Spec 007b (T12) · `Encolador.encolarLote`: lotes de 100, reserva del 50 % de los pendientes y nunca lanza.
// Sin BD ni Redis: dobles de `withTenant`, del repositorio y de `encolar`.
import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  contarPendientes: vi.fn(),
  leerConfig: vi.fn(),
}));
vi.mock("@contapp/queue", async (original) => ({
  ...(await original<typeof import("@contapp/queue")>()),
  encolar: vi.fn(),
}));

import { contarPendientes, leerConfig } from "@contapp/db";
import { ColaLlenaError, encolar, type EntradaEncolar } from "@contapp/queue";
import { Encolador, TAMANO_LOTE } from "./encolador.js";
import type { RedisTrabajos } from "./redis.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const TX = { tx: true };
const entrada = (i: number): EntradaEncolar => ({
  tipo: "cliente.consultar_ruc",
  clienteId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  parametros: {},
  prioridad: "programado",
  creadoPor: null,
});
const trabajoDe = (e: EntradaEncolar) => ({
  id: randomUUID(),
  tipo: e.tipo,
  clienteId: e.clienteId,
  estado: "en_cola",
  posicion: null,
  intentos: 0,
  motivo: null,
  creadoEn: new Date(0).toISOString(),
  iniciadoEn: null,
  terminadoEn: null,
  creadoPor: null,
});
const conexion = () => ({
  zadd: vi.fn(async () => 1),
  sadd: vi.fn(async () => 1),
  publish: vi.fn(async () => 1),
});

function armar(db: { withTenant: unknown }, r = conexion()) {
  const redis = { prefijo: "p:", publicador: () => r } as unknown as RedisTrabajos;
  return { r, enc: new Encolador(db as never, redis) };
}
const dbOk = () => ({ withTenant: vi.fn(async (_c: unknown, fn: (tx: unknown) => unknown) => fn(TX)) });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(leerConfig).mockResolvedValue(new Map([["xml", { maxPendientesTenant: 2000 }]]) as never);
  vi.mocked(contarPendientes).mockResolvedValue(0);
  vi.mocked(encolar).mockImplementation((async (_tx: unknown, e: EntradaEncolar) => ({ trabajo: trabajoDe(e), nuevo: true })) as never);
});

describe("Encolador.encolarLote", () => {
  it("inserta de 100 en 100, cada lote en su withTenant, y publica la pista y el evento de cada trabajo", async () => {
    const db = dbOk();
    const { enc, r } = armar(db);
    const res = await enc.encolarLote({ tenantId: TENANT }, Array.from({ length: 250 }, (_, i) => entrada(i)));
    expect(res).toEqual({ encoladas: 250, omitidas: 0 });
    expect(db.withTenant).toHaveBeenCalledTimes(Math.ceil(250 / TAMANO_LOTE));
    expect(r.zadd).toHaveBeenCalledTimes(250);
    expect(r.publish).toHaveBeenCalledTimes(250);
  });

  it("con reserva solo encola hasta la fracción del tope: 998 pendientes de 1.000 dejan pasar 2 de 5", async () => {
    vi.mocked(contarPendientes).mockResolvedValue(998);
    const { enc, r } = armar(dbOk());
    const res = await enc.encolarLote({ tenantId: TENANT }, [0, 1, 2, 3, 4].map(entrada), { reserva: 0.5 });
    expect(res).toEqual({ encoladas: 2, omitidas: 3 });
    expect(encolar).toHaveBeenCalledTimes(2);
    expect(r.zadd).toHaveBeenCalledTimes(2);
  });

  it("con la cola llena a mitad de lote conserva lo ya insertado y cuenta el resto como omitido", async () => {
    let n = 0;
    vi.mocked(encolar).mockImplementation((async (_tx: unknown, e: EntradaEncolar) => {
      if (++n > 2) throw new ColaLlenaError();
      return { trabajo: trabajoDe(e), nuevo: true };
    }) as never);
    const { enc } = armar(dbOk());
    expect(await enc.encolarLote({ tenantId: TENANT }, [0, 1, 2, 3].map(entrada))).toEqual({ encoladas: 2, omitidas: 2 });
  });

  it("si un lote falla (BD) no lanza, no publica y sigue con el siguiente", async () => {
    let llamadas = 0;
    const db = {
      withTenant: vi.fn(async (_c: unknown, fn: (tx: unknown) => unknown) => {
        if (++llamadas === 1) throw new Error("boom");
        return fn(TX);
      }),
    };
    const { enc, r } = armar(db);
    const res = await enc.encolarLote({ tenantId: TENANT }, Array.from({ length: 150 }, (_, i) => entrada(i)));
    expect(res).toEqual({ encoladas: 50, omitidas: 100 });
    expect(r.zadd).toHaveBeenCalledTimes(50);
  });

  it("sin configuración de la cola omite el lote; un trabajo ya vivo (dedupe) no se publica ni cuenta como encolado", async () => {
    vi.mocked(leerConfig).mockResolvedValueOnce(new Map() as never);
    const a = armar(dbOk());
    expect(await a.enc.encolarLote({ tenantId: TENANT }, [entrada(0), entrada(1)], { reserva: 0.5 })).toEqual({ encoladas: 0, omitidas: 2 });
    vi.mocked(encolar).mockImplementationOnce((async (_tx: unknown, e: EntradaEncolar) => ({ trabajo: trabajoDe(e), nuevo: false })) as never);
    const b = armar(dbOk());
    expect(await b.enc.encolarLote({ tenantId: TENANT }, [entrada(0), entrada(1)])).toEqual({ encoladas: 1, omitidas: 1 });
    expect(b.r.zadd).toHaveBeenCalledTimes(1);
  });

  it("un error de encolar que no es cola llena (BD) deshace el lote y lo cuenta omitido, sin lanzar", async () => {
    vi.mocked(encolar).mockRejectedValueOnce(new Error("boom"));
    const { enc, r } = armar(dbOk());
    expect(await enc.encolarLote({ tenantId: TENANT }, [entrada(0), entrada(1)])).toEqual({ encoladas: 0, omitidas: 2 });
    expect(r.zadd).not.toHaveBeenCalled();
  });

  it("con la app cerrando (sin conexión de publicación) cuenta los trabajos pero no publica; sin entradas no hace nada", async () => {
    const db = dbOk();
    const enc = new Encolador(db as never, { prefijo: "p:", publicador: () => null } as unknown as RedisTrabajos);
    expect(await enc.encolarLote({ tenantId: TENANT }, [entrada(0)])).toEqual({ encoladas: 1, omitidas: 0 });
    expect(await enc.encolarLote({ tenantId: TENANT }, [])).toEqual({ encoladas: 0, omitidas: 0 });
    expect(db.withTenant).toHaveBeenCalledTimes(1);
  });
});

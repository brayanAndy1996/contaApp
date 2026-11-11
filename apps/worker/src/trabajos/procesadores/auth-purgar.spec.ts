// Spec 017 · T4 (rojo). `auth.purgar` suma la purga de notificaciones (P-7, CA-15). BD y repositorios dobles.
// Contrato que fijan estas pruebas (T9), en procesadores/auth-purgar.ts:
//   - `NOTIFICACIONES_DIAS = 90` (exportada) y `OpcionesAuthPurgar.notificacionesDias?: number` (por omisión 90).
//   - Por cada estudio, en el MISMO `withTenant` (sin anidar) que `purgarTerminados`: `purgarNotificaciones(tx, notificacionesDias)`
//     de @contapp/db (envoltura de `notificacion_purgar`, solo borra lo del estudio actual, leído o no).
//   - `ResultadoAuthPurgar.notificaciones` = suma de lo borrado en todos los estudios; el log `auth_purgar_terminado` lleva el conteo.
//   - Es trabajo de sistema: sus `withTenant` NO llevan `trabajoId` (no hay fila en job_registro; el actor es `sistema`).
//   - La auditoría NO se purga (D-7, CA-15): no se llama a nada que la toque.
//   - Una retención de notificaciones menor a 1 día falla con `TrabajosRepoError("22023")` antes de abrir ninguna transacción.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  estudios: [] as string[],
  porEstudio: new Map<string, number>(),
  llamadasNotif: [] as Array<{ tx: unknown; dias: unknown; ctx: unknown }>,
  llamadasTrabajos: [] as unknown[],
  abiertas: 0,
  maxAbiertas: 0,
  ctxs: [] as unknown[],
  txActual: null as unknown,
}));

vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  purgarAuth: vi.fn(async () => ({
    sesiones: 1,
    tokens: 2,
    intentos: 3,
    limites: 4,
  })),
  estudiosIds: vi.fn(async () => [...h.estudios]),
  purgarTerminados: vi.fn(async (tx: unknown) => {
    h.llamadasTrabajos.push(tx);
    return 5;
  }),
  purgarNotificaciones: vi.fn(async (tx: unknown, dias: unknown) => {
    const ctx = (tx as { ctx: { tenantId: string } }).ctx;
    h.llamadasNotif.push({ tx, dias, ctx });
    return h.porEstudio.get(ctx.tenantId) ?? 0;
  }),
}));

import { TrabajosRepoError } from "@contapp/db";
import type { EventoLog } from "../registro.js";
import * as modulo from "./auth-purgar.js";
import { authPurgar } from "./auth-purgar.js";

const E1 = "0190a000-0000-7000-8000-0000000000e1";
const E2 = "0190a000-0000-7000-8000-0000000000e2";

function db() {
  return {
    withSistema: vi.fn(async (fn: (tx: unknown) => unknown) => {
      h.abiertas += 1;
      h.maxAbiertas = Math.max(h.maxAbiertas, h.abiertas);
      try {
        return await fn({ sistema: true });
      } finally {
        h.abiertas -= 1;
      }
    }),
    withTenant: vi.fn(async (ctx: unknown, fn: (tx: unknown) => unknown) => {
      h.ctxs.push(ctx);
      h.abiertas += 1;
      h.maxAbiertas = Math.max(h.maxAbiertas, h.abiertas);
      try {
        return await fn({ ctx });
      } finally {
        h.abiertas -= 1;
      }
    }),
  };
}

function logger() {
  const eventos: EventoLog[] = [];
  return {
    eventos,
    logger: {
      info: (e: EventoLog) => eventos.push(e),
      warn: (e: EventoLog) => eventos.push(e),
      error: (e: EventoLog) => eventos.push(e),
    },
  };
}

beforeEach(() => {
  h.estudios = [E1, E2];
  h.porEstudio = new Map([
    [E1, 3],
    [E2, 4],
  ]);
  h.llamadasNotif = [];
  h.llamadasTrabajos = [];
  h.abiertas = 0;
  h.maxAbiertas = 0;
  h.ctxs = [];
});

describe("auth.purgar y las notificaciones (P-7, CA-15)", () => {
  it("la retención por omisión es de 90 días", () => {
    expect((modulo as Record<string, unknown>).NOTIFICACIONES_DIAS).toBe(90);
  });

  it("purga las notificaciones de cada estudio con 90 días y suma lo borrado en `notificaciones`", async () => {
    const r = await authPurgar({ db: db() as never });
    expect(h.llamadasNotif.map((c) => [c.ctx, c.dias])).toEqual([
      [{ tenantId: E1 }, 90],
      [{ tenantId: E2 }, 90],
    ]);
    expect(r).toEqual({
      sesiones: 1,
      tokens: 2,
      intentos: 3,
      limites: 4,
      trabajos: 10,
      notificaciones: 7,
    });
  });

  it("usa la misma transacción de estudio que la purga de trabajos y nunca anida (un withTenant por estudio)", async () => {
    await authPurgar({ db: db() as never });
    expect(h.llamadasNotif.map((c) => c.tx)).toEqual(h.llamadasTrabajos);
    expect(h.maxAbiertas).toBe(1);
    expect(h.ctxs).toEqual([{ tenantId: E1 }, { tenantId: E2 }]);
  });

  it("es trabajo de sistema: ningún withTenant lleva trabajoId", async () => {
    await authPurgar({ db: db() as never });
    for (const c of h.ctxs) expect(c).not.toHaveProperty("trabajoId");
  });

  it("respeta `notificacionesDias`", async () => {
    await authPurgar({ db: db() as never, notificacionesDias: 30 } as never);
    expect(h.llamadasNotif.map((c) => c.dias)).toEqual([30, 30]);
  });

  it("sin estudios: notificaciones = 0 y no abre ningún withTenant", async () => {
    h.estudios = [];
    const d = db();
    const r = await authPurgar({ db: d as never });
    expect(r).toMatchObject({ trabajos: 0, notificaciones: 0 });
    expect(d.withTenant).not.toHaveBeenCalled();
  });

  it.each([0, -1, 0.5, Number.NaN, 36_501])(
    "una retención de notificaciones inválida (%s) falla con 22023 sin abrir ninguna transacción",
    async (dias) => {
      const d = db();
      const err = await authPurgar({
        db: d as never,
        notificacionesDias: dias,
      } as never).then(
        () => null,
        (x: unknown) => x,
      );
      expect(err).toBeInstanceOf(TrabajosRepoError);
      expect((err as { codigo?: string }).codigo).toBe("22023");
      expect(d.withSistema).not.toHaveBeenCalled();
      expect(d.withTenant).not.toHaveBeenCalled();
      expect(h.llamadasNotif).toHaveLength(0);
    },
  );

  it("el log final lleva el conteo de notificaciones y solo números (D-14)", async () => {
    const { logger: l, eventos } = logger();
    await authPurgar({ db: db() as never, logger: l });
    const fin = eventos.find((e) => e.evento === "auth_purgar_terminado");
    expect(fin).toMatchObject({ notificaciones: 7, trabajos: 10 });
    for (const [campo, v] of Object.entries(fin!))
      if (campo !== "evento") expect(typeof v, campo).toBe("number");
  });
});

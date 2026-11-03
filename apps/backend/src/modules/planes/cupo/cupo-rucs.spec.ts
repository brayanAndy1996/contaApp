import { HttpException } from "@nestjs/common";
import type { Tx } from "@contapp/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlanNoDisponibleError } from "./errores.js";
import { CUPO_RUCS, CupoRucsError, CupoRucsPlanes } from "./cupo-rucs.js";

// T2 de 006 (rojo). Puerto `CupoRucs` (D4, CA-5) con `tx` falsa. Contrato fijado:
//  - `new CupoRucsPlanes()` sin argumentos (adaptador del puerto `CupoRucs`; token `CUPO_RUCS`).
//  - Usa de `@contapp/db`: bloquearCupo(tx, tenantId), leerLimites(tx, tenantId) -> {maxRucs, maxUsuarios,
//    maxRucsExtra, rucsExtraContratados} | null, contarRucs(tx, tenantId) -> number (hoy todas las
//    filas de `cliente`; 007 pasa a activos).
//  - limite efectivo = limiteEfectivoRucs(maxRucs, maxRucsExtra, contratados) de `@contapp/shared` (D6).
//  - `libres` y `reservar` toman el bloqueo ANTES de contar (D4). `libres` = max(0, limite - usados).
//    `reservar(n)` rechaza con CupoRucsError (409 cupo_rucs) si usados + n > limite; no escribe nada
//    (el INSERT lo hace 007 despues) y no usa SQL crudo (`tx.query`).
//  - Sin suscripcion (leerLimites null) -> PlanNoDisponibleError (409 sin_plan).
const { orden, bloquearCupo, leerLimites, contarRucs } = vi.hoisted(() => {
  const orden: string[] = [];
  return {
    orden,
    bloquearCupo: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => {
      orden.push("bloquear");
    }),
    leerLimites: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => null),
    contarRucs: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => 0),
  };
});
vi.mock("@contapp/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@contapp/db")>()),
  bloquearCupo: (...a: unknown[]) => bloquearCupo(...a),
  leerLimites: (...a: unknown[]) => leerLimites(...a),
  contarRucs: (...a: unknown[]) => contarRucs(...a),
}));

const T_A = "0190a000-0000-7000-8000-0000000000aa";
const query = vi.fn();
const tx = { query } as unknown as Tx;

const plan = (maxRucs: number, maxRucsExtra: number, contratados: number) =>
  leerLimites.mockResolvedValue({
    maxRucs,
    maxUsuarios: 5,
    maxRucsExtra,
    rucsExtraContratados: contratados,
  });
const usados = (n: number) =>
  contarRucs.mockImplementation(async () => {
    orden.push("contar");
    return n;
  });

async function error(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("se esperaba un rechazo");
}

beforeEach(() => {
  orden.length = 0;
  bloquearCupo.mockClear();
  leerLimites.mockReset();
  leerLimites.mockResolvedValue(null);
  contarRucs.mockReset();
  usados(0);
  query.mockClear();
});

describe("CupoRucsError y token", () => {
  it("CupoRucsError es un 409 con { codigo: 'cupo_rucs' }, sin datos del estudio ni del plan", () => {
    const e = new CupoRucsError();
    expect(e).toBeInstanceOf(HttpException);
    expect(e.getStatus()).toBe(409);
    expect(e.getResponse()).toMatchObject({ codigo: "cupo_rucs" });
  });

  it("CUPO_RUCS es un token de inyeccion unico (Symbol)", () => {
    expect(typeof CUPO_RUCS).toBe("symbol");
  });
});

describe("CupoRucsPlanes.libres (CA-5)", () => {
  it.each([
    // [maxRucs, maxRucsExtra, contratados, usados, libres]
    [30, 6, 0, 0, 30],
    [30, 6, 0, 30, 0],
    [30, 6, 4, 30, 4],
    [30, 6, 4, 34, 0],
    [30, 6, 10, 0, 36],
    [100, 20, 0, 99, 1],
    [5, 0, 0, 5, 0],
  ] as const)(
    "plan %i + extra tope %i contratados %i, usados %i -> libres %i",
    async (maxRucs, maxRucsExtra, contratados, n, libres) => {
      plan(maxRucs, maxRucsExtra, contratados);
      usados(n);
      expect(await new CupoRucsPlanes().libres(tx, T_A)).toBe(libres);
    },
  );

  it("CA-7: si ya excede el limite (plan bajado) libres es 0, nunca negativo", async () => {
    plan(30, 6, 0);
    usados(45);
    expect(await new CupoRucsPlanes().libres(tx, T_A)).toBe(0);
  });

  it("archivar libera el cupo en la consulta siguiente (se vuelve a contar cada vez)", async () => {
    plan(10, 0, 0);
    const cupo = new CupoRucsPlanes();
    usados(10);
    expect(await cupo.libres(tx, T_A)).toBe(0);
    usados(7); // se archivaron 3
    expect(await cupo.libres(tx, T_A)).toBe(3);
  });

  it("toma el bloqueo del cupo antes de contar (D4: ambas operaciones serializan)", async () => {
    plan(10, 0, 0);
    await new CupoRucsPlanes().libres(tx, T_A);
    expect(bloquearCupo).toHaveBeenCalledWith(tx, T_A);
    expect(orden).toEqual(["bloquear", "contar"]);
  });

  it("sin suscripcion falla cerrado con PlanNoDisponibleError (409 sin_plan)", async () => {
    leerLimites.mockResolvedValue(null);
    const e = await error(new CupoRucsPlanes().libres(tx, T_A));
    expect(e).toBeInstanceOf(PlanNoDisponibleError);
    expect((e as HttpException).getStatus()).toBe(409);
  });
});

describe("CupoRucsPlanes.reservar (CA-5)", () => {
  const reservar = (n: number) => new CupoRucsPlanes().reservar(tx, T_A, n);
  const rechazado = async (n: number) => {
    const e = await error(reservar(n));
    expect(e).toBeInstanceOf(CupoRucsError);
    expect((e as HttpException).getStatus()).toBe(409);
    expect((e as HttpException).getResponse()).toMatchObject({
      codigo: "cupo_rucs",
    });
  };

  describe("n = 1 (crear o reactivar un cliente)", () => {
    it("con un cupo libre entra", async () => {
      plan(30, 6, 0);
      usados(29);
      await expect(reservar(1)).resolves.toBeUndefined();
    });
    it("en el limite exacto se rechaza", async () => {
      plan(30, 6, 0);
      usados(30);
      await rechazado(1);
    });
    it("los adicionales contratados suman cupo (D6): 30 + 4", async () => {
      plan(30, 6, 4);
      usados(33);
      await expect(reservar(1)).resolves.toBeUndefined();
      usados(34);
      await rechazado(1);
    });
    it("los contratados sobre el tope no dan mas cupo (D10): 30 + min(10, 6)", async () => {
      plan(30, 6, 10);
      usados(35);
      await expect(reservar(1)).resolves.toBeUndefined();
      usados(36);
      await rechazado(1);
    });
  });

  describe("n = 50 (importacion)", () => {
    it("entra si activos + 50 <= limite", async () => {
      plan(100, 20, 0);
      usados(50);
      await expect(reservar(50)).resolves.toBeUndefined();
    });
    it("se rechaza completa si activos + 50 supera el limite (no entra una parte)", async () => {
      plan(100, 20, 0);
      usados(51);
      await rechazado(50);
    });
    it("con un plan de 5 RUCs, 50 nunca caben", async () => {
      plan(5, 0, 0);
      usados(0);
      await rechazado(50);
    });
    it("con adicionales: 100 + 20 admite 50 sobre 70 usados", async () => {
      plan(100, 20, 20);
      usados(70);
      await expect(reservar(50)).resolves.toBeUndefined();
      usados(71);
      await rechazado(50);
    });
  });

  describe("n = 0", () => {
    it("no pide cupo: resuelve incluso en el limite exacto", async () => {
      plan(30, 6, 0);
      usados(30);
      await expect(reservar(0)).resolves.toBeUndefined();
    });
  });

  it("CA-7: con el estudio por encima del limite (plan bajado) no deja agregar ni uno", async () => {
    plan(30, 6, 0);
    usados(45);
    await rechazado(1);
  });

  it("toma el bloqueo del cupo antes de contar y lo hace con la tx del llamador", async () => {
    plan(30, 6, 0);
    usados(1);
    await reservar(1);
    expect(bloquearCupo).toHaveBeenCalledWith(tx, T_A);
    expect(orden).toEqual(["bloquear", "contar"]);
    expect(contarRucs).toHaveBeenCalledWith(tx, T_A);
  });

  it("el rechazo tambien ocurre despues de bloquear (la tx del llamador conserva el bloqueo hasta el commit)", async () => {
    plan(1, 0, 0);
    usados(1);
    await error(reservar(1));
    expect(bloquearCupo).toHaveBeenCalledTimes(1);
  });

  it("no escribe nada ni usa SQL crudo: solo bloquea y cuenta", async () => {
    plan(30, 6, 0);
    usados(1);
    await reservar(5);
    expect(query).not.toHaveBeenCalled();
  });

  it("sin suscripcion falla cerrado con PlanNoDisponibleError (409 sin_plan), nunca 'sin limite'", async () => {
    leerLimites.mockResolvedValue(null);
    const e = await error(reservar(1));
    expect(e).toBeInstanceOf(PlanNoDisponibleError);
    expect((e as HttpException).getStatus()).toBe(409);
  });

  it("CA-2: relee los limites en cada llamada, sin cache (cambiar el plan en BD cambia el resultado)", async () => {
    const cupo = new CupoRucsPlanes();
    usados(30);
    plan(30, 0, 0);
    expect(await error(cupo.reservar(tx, T_A, 1))).toBeInstanceOf(CupoRucsError);
    plan(31, 0, 0); // el super-admin sube max_rucs
    await expect(cupo.reservar(tx, T_A, 1)).resolves.toBeUndefined();
    plan(30, 6, 1); // o le asigna un adicional
    await expect(cupo.reservar(tx, T_A, 1)).resolves.toBeUndefined();
    expect(leerLimites).toHaveBeenCalledTimes(3);
  });

  it("un fallo del conteo o del bloqueo no concede cupo", async () => {
    plan(30, 6, 0);
    contarRucs.mockRejectedValueOnce(new Error("falla de conteo"));
    await expect(reservar(1)).rejects.toThrow("falla de conteo");
    bloquearCupo.mockRejectedValueOnce(new Error("falla de bloqueo"));
    await expect(reservar(1)).rejects.toThrow("falla de bloqueo");
  });
});

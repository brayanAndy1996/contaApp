import { HttpException } from "@nestjs/common";
import type { AuthRepo, Tx } from "@contapp/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CupoUsuariosError } from "../../acceso/cupo/cupo-usuarios.js";
import { PlanNoDisponibleError } from "./errores.js";
import { CupoUsuariosPlanes } from "./cupo-usuarios-planes.js";

// T2 de 006 (rojo). Adaptador real de `CupoUsuarios` de 005 (D7, CA-6) con `tx` falsa. Contrato fijado:
//  - `new CupoUsuariosPlanes()` sin argumentos; usa de `@contapp/db` (packages/db/src/planes): 
//      bloquearCupo(tx, tenantId)      -> void   (advisory xact lock `plan.cupo:<tenant>`)
//      leerLimites(tx, tenantId)       -> { maxRucs, maxUsuarios: number|null, maxRucsExtra,
//                                           rucsExtraContratados } | null   (null = sin suscripcion)
//      contarUsuarios(tx, tenantId)    -> { activos, pendientes }
//  - alInvitar/alReactivar: bloquean ANTES de contar y exigen activos + pendientes + 1 <= max (D7).
//  - alAceptar(a, tenantId): `a.cupoUsuariosAceptar(tenantId)` (la funcion SQL toma el bloqueo y
//    comprueba activos + 1 <= max); false -> CupoUsuariosError. No cuenta ni bloquea desde el backend.
//  - max_usuarios nulo = sin limite. Sin suscripcion (leerLimites null) -> PlanNoDisponibleError (409 sin_plan).
//  - Sin cache: cada llamada relee los limites (CA-2: cambiar el plan en BD cambia el comportamiento).
const { orden, bloquearCupo, leerLimites, contarUsuarios } = vi.hoisted(() => {
  const orden: string[] = [];
  return {
    orden,
    bloquearCupo: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => {
      orden.push("bloquear");
    }),
    leerLimites: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => {
      orden.push("limites");
      return null as unknown;
    }),
    contarUsuarios: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => {
      orden.push("contar");
      return { activos: 0, pendientes: 0 } as unknown;
    }),
  };
});
vi.mock("@contapp/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@contapp/db")>()),
  bloquearCupo: (...a: unknown[]) => bloquearCupo(...a),
  leerLimites: (...a: unknown[]) => leerLimites(...a),
  contarUsuarios: (...a: unknown[]) => contarUsuarios(...a),
}));

const T_A = "0190a000-0000-7000-8000-0000000000aa";
const tx = { query: vi.fn() } as unknown as Tx;

const limites = (maxUsuarios: number | null) => ({
  maxRucs: 100,
  maxUsuarios,
  maxRucsExtra: 20,
  rucsExtraContratados: 0,
});
const hay = (max: number | null, activos: number, pendientes: number) => {
  // Ajuste de 006: mockResolvedValue reemplazaba la implementacion que anota en `orden`, y la prueba de orden
  // (bloquear antes de contar) nunca veia "contar". Se conserva el registro y se devuelve el valor fijado.
  leerLimites.mockImplementation(async () => {
    orden.push("limites");
    return limites(max);
  });
  contarUsuarios.mockImplementation(async () => {
    orden.push("contar");
    return { activos, pendientes };
  });
};

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
  leerLimites.mockImplementation(async () => {
    orden.push("limites");
    return null;
  });
  contarUsuarios.mockReset();
  contarUsuarios.mockImplementation(async () => {
    orden.push("contar");
    return { activos: 0, pendientes: 0 };
  });
  (tx as unknown as { query: ReturnType<typeof vi.fn> }).query.mockClear();
});

describe.each(["alInvitar", "alReactivar"] as const)(
  "CupoUsuariosPlanes.%s (D7: activos + pendientes + 1 <= max)",
  (metodo) => {
    const llamar = () => new CupoUsuariosPlanes()[metodo](tx, T_A);

    it.each([
      // [max, activos, pendientes, cabe]
      [5, 3, 1, true],
      [5, 4, 0, true],
      [5, 3, 2, false],
      [5, 5, 0, false],
      [5, 0, 5, false],
      [1, 0, 0, true],
      [1, 1, 0, false],
      [1, 0, 1, false],
      [2, 1, 0, true],
      [2, 1, 1, false],
      [15, 10, 4, true],
      [15, 10, 5, false],
    ] as const)(
      "max %i con %i activos y %i pendientes -> %s",
      async (max, activos, pendientes, cabe) => {
        hay(max, activos, pendientes);
        if (cabe) {
          await expect(llamar()).resolves.toBeUndefined();
        } else {
          const e = await error(llamar());
          expect(e).toBeInstanceOf(CupoUsuariosError);
          expect((e as HttpException).getStatus()).toBe(409);
          expect((e as HttpException).getResponse()).toEqual({
            codigo: "cupo_usuarios",
          });
        }
      },
    );

    it("CA-7: si el estudio ya excede el limite (plan bajado) rechaza sin tocar nada mas", async () => {
      hay(2, 4, 1);
      expect(await error(llamar())).toBeInstanceOf(CupoUsuariosError);
      expect(
        (tx as unknown as { query: ReturnType<typeof vi.fn> }).query,
      ).not.toHaveBeenCalled();
    });

    it("max_usuarios nulo no limita, por grande que sea el uso (D1)", async () => {
      hay(null, 10_000, 10_000);
      await expect(llamar()).resolves.toBeUndefined();
    });

    it("pasa la misma tx y el estudio a bloquear, leer limites y contar", async () => {
      hay(5, 1, 0);
      await llamar();
      expect(bloquearCupo).toHaveBeenCalledWith(tx, T_A);
      expect(leerLimites).toHaveBeenCalledWith(tx, T_A);
      expect(contarUsuarios).toHaveBeenCalledWith(tx, T_A);
    });

    it("toma el bloqueo del cupo ANTES de contar (orden de bloqueo del plan)", async () => {
      hay(5, 1, 0);
      await llamar();
      expect(orden.indexOf("bloquear")).toBeGreaterThanOrEqual(0);
      expect(orden.indexOf("contar")).toBeGreaterThan(orden.indexOf("bloquear"));
    });

    it("el bloqueo se toma aunque despues se rechace (el rechazo ocurre dentro de la tx del llamador)", async () => {
      hay(1, 1, 0);
      await error(llamar());
      expect(bloquearCupo).toHaveBeenCalledTimes(1);
    });

    it("sin suscripcion falla cerrado: PlanNoDisponibleError (409 sin_plan), nunca 'sin limite'", async () => {
      leerLimites.mockResolvedValue(null);
      const e = await error(llamar());
      expect(e).toBeInstanceOf(PlanNoDisponibleError);
      expect((e as HttpException).getStatus()).toBe(409);
      expect((e as HttpException).getResponse()).toMatchObject({
        codigo: "sin_plan",
      });
    });

    it("CA-2: cada llamada relee los limites, sin cache (cambiar el plan en BD cambia el resultado)", async () => {
      const cupo = new CupoUsuariosPlanes();
      hay(2, 1, 0);
      await expect(cupo[metodo](tx, T_A)).resolves.toBeUndefined();
      hay(1, 1, 0); // el super-admin baja max_usuarios de 2 a 1
      expect(await error(cupo[metodo](tx, T_A))).toBeInstanceOf(
        CupoUsuariosError,
      );
      hay(null, 1, 0); // y luego lo deja ilimitado
      await expect(cupo[metodo](tx, T_A)).resolves.toBeUndefined();
      expect(leerLimites).toHaveBeenCalledTimes(3);
    });

    it("no hay un numero de limite en el codigo: con max 3 y 3 usados rechaza, con max 4 acepta", async () => {
      hay(3, 3, 0);
      expect(await error(llamar())).toBeInstanceOf(CupoUsuariosError);
      hay(4, 3, 0);
      await expect(llamar()).resolves.toBeUndefined();
    });

    it("un fallo del bloqueo o de la lectura no concede cupo", async () => {
      hay(5, 0, 0);
      bloquearCupo.mockRejectedValueOnce(new Error("falla simulada"));
      await expect(llamar()).rejects.toThrow("falla simulada");
      contarUsuarios.mockRejectedValueOnce(new Error("falla de conteo"));
      await expect(llamar()).rejects.toThrow("falla de conteo");
    });
  },
);

describe("CupoUsuariosPlanes.alAceptar (D7: la invitacion ya estaba contada)", () => {
  const repo = (devuelve: boolean) => {
    const cupoUsuariosAceptar = vi.fn<(t: string) => Promise<boolean>>(async () => devuelve);
    return {
      auth: { cupoUsuariosAceptar } as unknown as AuthRepo,
      cupoUsuariosAceptar,
    };
  };

  it("hay cupo: llama cupoUsuariosAceptar(tenantId) y resuelve", async () => {
    const { auth, cupoUsuariosAceptar } = repo(true);
    await expect(
      new CupoUsuariosPlanes().alAceptar(auth, T_A),
    ).resolves.toBeUndefined();
    expect(cupoUsuariosAceptar).toHaveBeenCalledTimes(1);
    expect(cupoUsuariosAceptar).toHaveBeenCalledWith(T_A);
  });

  it("sin cupo (plan bajado entre invitar y aceptar): CupoUsuariosError 409 cupo_usuarios", async () => {
    const { auth } = repo(false);
    const e = await error(new CupoUsuariosPlanes().alAceptar(auth, T_A));
    expect(e).toBeInstanceOf(CupoUsuariosError);
    expect((e as HttpException).getStatus()).toBe(409);
    expect((e as HttpException).getResponse()).toEqual({
      codigo: "cupo_usuarios",
    });
  });

  it("no cuenta ni bloquea desde el backend: la funcion SQL toma el bloqueo y compara", async () => {
    const { auth } = repo(true);
    await new CupoUsuariosPlanes().alAceptar(auth, T_A);
    expect(bloquearCupo).not.toHaveBeenCalled();
    expect(contarUsuarios).not.toHaveBeenCalled();
    expect(leerLimites).not.toHaveBeenCalled();
  });

  it("un fallo de la funcion SQL no concede cupo", async () => {
    const cupoUsuariosAceptar = vi.fn(async () => {
      throw new Error("falla simulada");
    });
    await expect(
      new CupoUsuariosPlanes().alAceptar(
        { cupoUsuariosAceptar } as unknown as AuthRepo,
        T_A,
      ),
    ).rejects.toThrow("falla simulada");
  });
});

describe("PlanNoDisponibleError", () => {
  it("es un 409 con { codigo: 'sin_plan' } y sin datos del estudio", () => {
    const e = new PlanNoDisponibleError();
    expect(e).toBeInstanceOf(HttpException);
    expect(e.getStatus()).toBe(409);
    expect(e.getResponse()).toEqual({ codigo: "sin_plan" });
  });
});

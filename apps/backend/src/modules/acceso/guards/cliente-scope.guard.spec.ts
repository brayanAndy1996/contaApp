import "reflect-metadata";
import { HttpException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { ContappDb } from "@contapp/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SesionResuelta } from "../../auth/auth.service.js";
import {
  fijarSesion,
  type PeticionAuth,
} from "../../auth/guards/decoradores.js";
import { generarToken } from "../../auth/sesion/token.js";
import { ClienteScopeGuard } from "./cliente-scope.guard.js";

// Unitarias de ClienteScopeGuard con dobles (T3 de 005). Contrato (plan: Guards y decoradores):
//  - `new ClienteScopeGuard(reflector, db)`; la visibilidad sale de
//    `clienteVisible(tx, clienteId, alcance) -> boolean` de `@contapp/db` (D5), con
//    alcance `{ tipo: 'global' }` o `{ tipo: 'asignado', usuarioId }` segun `req.acceso.alcance`.
//  - solo actua si la ruta trae `:clienteId` (`req.params.clienteId`); exige `req.acceso` (si falta,
//    403 permiso_denegado); cliente inexistente, ajeno y no asignado -> el MISMO 404 no_encontrado;
//    un UUID mal formado -> 404 sin tocar la BD.
const { clienteVisible } = vi.hoisted(() => ({ clienteVisible: vi.fn() }));
vi.mock("@contapp/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@contapp/db")>()),
  clienteVisible: (...a: unknown[]) => clienteVisible(...a),
}));

const T_A = "0190a000-0000-7000-8000-0000000000aa";
const C1 = "0190a000-0000-7000-8000-0000000000c1";
const C2 = "0190a000-0000-7000-8000-0000000000c2";
const C3 = "0190a000-0000-7000-8000-0000000000c3";
const reflector = new Reflector();
const tx = { marca: "tx-de-prueba" };
const withTenant = vi.fn(
  async (_ctx: unknown, fn: (t: unknown) => Promise<unknown>) => fn(tx),
);
const db = { withTenant } as unknown as Pick<ContappDb, "withTenant">;

type Req = PeticionAuth & {
  acceso?: Record<string, unknown>;
  params?: Record<string, string>;
};
class Controlador {}

function sesion(): SesionResuelta {
  return {
    token: generarToken(),
    sesionId: "s1",
    usuarioId: "u1",
    tenantActivo: T_A,
    estudioRevocado: false,
    expiraAbsoluta: new Date(Date.now() + 3_600_000),
  };
}

/** Peticion como la deja PermisoGuard: `acceso` no enumerable. */
function peticion(
  o: { clienteId?: string; alcance?: "global" | "asignado" | null } = {},
): Req {
  const req: Req = {
    method: "GET",
    headers: {},
    params: o.clienteId === undefined ? {} : { clienteId: o.clienteId },
  };
  fijarSesion(req, sesion());
  const alcance = o.alcance === undefined ? "asignado" : o.alcance;
  if (alcance !== null) {
    Object.defineProperty(req, "acceso", {
      value: {
        usuarioId: "u1",
        rol: alcance === "global" ? "admin" : "asistente",
        permisos: ["clientes.ver"],
        alcance,
      },
      enumerable: false,
      configurable: true,
    });
  }
  return req;
}

const ctx = (req: Req): ExecutionContext =>
  ({
    getHandler: () => () => undefined,
    getClass: () => Controlador,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
  }) as unknown as ExecutionContext;

async function rechazo(req: Req): Promise<{ estado: number; cuerpo: unknown }> {
  try {
    await new ClienteScopeGuard(reflector, db).canActivate(ctx(req));
  } catch (e) {
    expect(e).toBeInstanceOf(HttpException);
    return {
      estado: (e as HttpException).getStatus(),
      cuerpo: (e as HttpException).getResponse(),
    };
  }
  throw new Error("se esperaba un rechazo");
}

const pasa = (req: Req) =>
  new ClienteScopeGuard(reflector, db).canActivate(ctx(req));
const NO_ENCONTRADO = { estado: 404, cuerpo: { codigo: "no_encontrado" } };

beforeEach(() => {
  clienteVisible.mockReset();
  withTenant.mockClear();
});

describe("ClienteScopeGuard: rutas sin :clienteId", () => {
  it("pasa sin consultar nada", async () => {
    expect(await pasa(peticion())).toBe(true);
    expect(withTenant).not.toHaveBeenCalled();
    expect(clienteVisible).not.toHaveBeenCalled();
  });

  it("pasa aunque no haya req.acceso (la ruta no depende del cliente)", async () => {
    expect(await pasa(peticion({ alcance: null }))).toBe(true);
    expect(clienteVisible).not.toHaveBeenCalled();
  });
});

describe("ClienteScopeGuard: alcance (D5, CA-5)", () => {
  it("alcance global: consulta clienteVisible con { tipo: 'global' } en el estudio de la sesion", async () => {
    clienteVisible.mockResolvedValue(true);
    expect(await pasa(peticion({ clienteId: C1, alcance: "global" }))).toBe(
      true,
    );
    expect(withTenant).toHaveBeenCalledTimes(1);
    expect(withTenant.mock.calls[0]?.[0]).toEqual({
      tenantId: T_A,
      userId: "u1",
    });
    expect(clienteVisible).toHaveBeenCalledWith(tx, C1, { tipo: "global" });
  });

  it("alcance asignado: consulta clienteVisible con { tipo: 'asignado', usuarioId }", async () => {
    clienteVisible.mockResolvedValue(true);
    expect(await pasa(peticion({ clienteId: C2, alcance: "asignado" }))).toBe(
      true,
    );
    expect(clienteVisible).toHaveBeenCalledWith(tx, C2, {
      tipo: "asignado",
      usuarioId: "u1",
    });
  });

  it.each([["global"], ["asignado"]] as const)(
    "con alcance %s, cliente inexistente, ajeno y no asignado dan exactamente el mismo 404",
    async (alcance) => {
      clienteVisible.mockResolvedValue(false);
      const inexistente = await rechazo(peticion({ clienteId: C1, alcance }));
      const ajeno = await rechazo(peticion({ clienteId: C2, alcance }));
      const noAsignado = await rechazo(peticion({ clienteId: C3, alcance }));
      expect(inexistente).toEqual(NO_ENCONTRADO);
      expect(ajeno).toEqual(inexistente);
      expect(noAsignado).toEqual(inexistente);
      expect(clienteVisible).toHaveBeenCalledTimes(3);
    },
  );

  it("el cuerpo del 404 no menciona el cliente ni el motivo", async () => {
    clienteVisible.mockResolvedValue(false);
    const r = await rechazo(peticion({ clienteId: C1 }));
    expect(JSON.stringify(r.cuerpo)).not.toContain(C1);
    expect(Object.keys(r.cuerpo as object)).toEqual(["codigo"]);
  });
});

describe("ClienteScopeGuard: entradas hostiles", () => {
  it.each([
    ["no-es-uuid"],
    ["123"],
    [""],
    ["' OR 1=1 --"],
    ["0190a000-0000-7000-8000-00000000zzzz"],
    ["../../etc/passwd"],
    [`${C1}0`],
    [C1.slice(0, -1)],
  ])("clienteId mal formado (%j): 404 sin tocar la BD", async (malo) => {
    expect(await rechazo(peticion({ clienteId: malo }))).toEqual(NO_ENCONTRADO);
    expect(clienteVisible).not.toHaveBeenCalled();
    expect(withTenant).not.toHaveBeenCalled();
  });

  it("con :clienteId pero sin req.acceso: 403 permiso_denegado y no consulta el cliente", async () => {
    clienteVisible.mockResolvedValue(true);
    const r = await rechazo(peticion({ clienteId: C1, alcance: null }));
    expect(r).toEqual({ estado: 403, cuerpo: { codigo: "permiso_denegado" } });
    expect(clienteVisible).not.toHaveBeenCalled();
    expect(withTenant).not.toHaveBeenCalled();
  });

  it("un fallo de la BD no concede acceso", async () => {
    clienteVisible.mockRejectedValue(new Error("falla simulada"));
    await expect(pasa(peticion({ clienteId: C1 }))).rejects.toThrow();
  });
});

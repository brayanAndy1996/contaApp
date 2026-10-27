import "reflect-metadata";
import {
  HttpException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
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
import { Permiso } from "./decoradores.js";
import { PermisoGuard } from "./permiso.guard.js";

// Orden Permiso -> Alcance (plan: Decisiones; CA-5): el 403 sale antes de mirar el cliente, asi que
// no revela si existe. Los guards se encadenan como lo hace Nest (el primer rechazo corta).
const { miembroActual, clienteVisible } = vi.hoisted(() => ({
  miembroActual: vi.fn(),
  clienteVisible: vi.fn(),
}));
vi.mock("@contapp/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@contapp/db")>()),
  miembroActual: (...a: unknown[]) => miembroActual(...a),
  clienteVisible: (...a: unknown[]) => clienteVisible(...a),
}));

const T_A = "0190a000-0000-7000-8000-0000000000aa";
const CLIENTE = "0190a000-0000-7000-8000-0000000000c1";
const reflector = new Reflector();
const db = {
  withTenant: vi.fn(async (_c: unknown, fn: (t: unknown) => Promise<unknown>) =>
    fn({}),
  ),
} as unknown as Pick<ContappDb, "withTenant">;
class Controlador {}

function peticion(): PeticionAuth & { params: Record<string, string> } {
  const s: SesionResuelta = {
    token: generarToken(),
    sesionId: "s1",
    usuarioId: "u1",
    tenantActivo: T_A,
    estudioRevocado: false,
    expiraAbsoluta: new Date(Date.now() + 3_600_000),
  };
  const req = { method: "PUT", headers: {}, params: { clienteId: CLIENTE } };
  fijarSesion(req, s);
  return req;
}

async function encadenar(
  rol: string | null,
  permiso: Parameters<typeof Permiso>[0],
) {
  miembroActual.mockResolvedValue(
    rol === null ? null : { usuarioId: "u1", rol },
  );
  const handler = () => undefined;
  Permiso(permiso)(handler);
  const req = peticion();
  const contexto = {
    getHandler: () => handler,
    getClass: () => Controlador,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
  } as unknown as ExecutionContext;
  const guards: CanActivate[] = [
    new PermisoGuard(reflector, db),
    new ClienteScopeGuard(reflector, db),
  ];
  try {
    for (const g of guards) await g.canActivate(contexto);
    return { ok: true as const };
  } catch (e) {
    expect(e).toBeInstanceOf(HttpException);
    return {
      ok: false as const,
      estado: (e as HttpException).getStatus(),
      cuerpo: (e as HttpException).getResponse(),
    };
  }
}

beforeEach(() => {
  miembroActual.mockReset();
  clienteVisible.mockReset();
});

describe("Permiso antes que Alcance (CA-5)", () => {
  it("sin el permiso: 403 permiso_denegado y nunca se consulta el cliente", async () => {
    clienteVisible.mockResolvedValue(false);
    const r = await encadenar("lectura", "clientes.asignar");
    expect(r).toEqual({
      ok: false,
      estado: 403,
      cuerpo: { codigo: "permiso_denegado" },
    });
    expect(clienteVisible).not.toHaveBeenCalled();
  });

  it("el 403 es el mismo exista o no el cliente", async () => {
    clienteVisible.mockResolvedValue(true);
    const existe = await encadenar("asistente", "clientes.asignar");
    clienteVisible.mockReset();
    clienteVisible.mockResolvedValue(false);
    const noExiste = await encadenar("asistente", "clientes.asignar");
    expect(noExiste).toEqual(existe);
    expect(clienteVisible).not.toHaveBeenCalled();
  });

  it("con el permiso y cliente no visible: 404 no_encontrado", async () => {
    clienteVisible.mockResolvedValue(false);
    const r = await encadenar("contador", "clientes.ver");
    expect(r).toEqual({
      ok: false,
      estado: 404,
      cuerpo: { codigo: "no_encontrado" },
    });
    expect(clienteVisible).toHaveBeenCalledTimes(1);
  });

  it("con el permiso y cliente visible: pasa los dos guards", async () => {
    clienteVisible.mockResolvedValue(true);
    expect(await encadenar("admin", "clientes.asignar")).toEqual({ ok: true });
  });

  it("sin membresia activa: 403 estudio_requerido y no se consulta el cliente", async () => {
    const r = await encadenar(null, "clientes.ver");
    expect(r).toEqual({
      ok: false,
      estado: 403,
      cuerpo: { codigo: "estudio_requerido" },
    });
    expect(clienteVisible).not.toHaveBeenCalled();
  });
});

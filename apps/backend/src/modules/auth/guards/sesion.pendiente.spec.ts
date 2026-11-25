import "reflect-metadata";
import { HttpException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";
import type { SesionResuelta } from "../auth.service.js";
import { generarToken } from "../sesion/token.js";
import { PermitirPendiente, SesionOpcional, sesionDe, type PeticionAuth } from "./decoradores.js";
import { SesionGuard } from "./sesion.guard.js";

// 029 (T7, CA-2) · la sesión `pendiente` solo vale en `@PermitirPendiente()`; en cualquier otra ruta es como no tener sesión.
const reflector = new Reflector();
class Controlador {}

function pendiente(): SesionResuelta {
  return {
    token: generarToken(),
    sesionId: "s1",
    usuarioId: "u1",
    tenantActivo: null,
    estudioRevocado: false,
    factor: "pendiente",
    expiraAbsoluta: new Date(Date.now() + 300_000),
  };
}

function contexto(req: PeticionAuth, decorar?: (fn: () => void) => void): ExecutionContext {
  const fn = () => undefined;
  decorar?.(fn);
  return {
    getHandler: () => fn,
    getClass: () => Controlador,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
  } as unknown as ExecutionContext;
}

const guard = () => new SesionGuard(reflector, { resolverSesion: vi.fn(async () => pendiente()) });

describe("SesionGuard · sesión pendiente", () => {
  it("con @PermitirPendiente la fija (verificar, logout)", async () => {
    const req: PeticionAuth = { method: "POST", headers: { cookie: "a=1" } };
    expect(await guard().canActivate(contexto(req, (fn) => PermitirPendiente()(fn)))).toBe(true);
    expect(sesionDe(req)?.factor).toBe("pendiente");
  });

  it("sin la marca: 401 sesion_invalida y no la fija; en @SesionOpcional sigue sin sesión", async () => {
    const req: PeticionAuth = { method: "GET", headers: { cookie: "a=1" } };
    const e = await guard()
      .canActivate(contexto(req))
      .then(
        () => null,
        (x: unknown) => x,
      );
    expect(e).toBeInstanceOf(HttpException);
    expect((e as HttpException).getResponse()).toEqual({ codigo: "sesion_invalida" });
    expect(sesionDe(req)).toBeNull();
    const opcional: PeticionAuth = { method: "POST", headers: { cookie: "a=1" } };
    expect(await guard().canActivate(contexto(opcional, (fn) => SesionOpcional()(fn)))).toBe(true);
    expect(sesionDe(opcional)).toBeNull();
  });
});

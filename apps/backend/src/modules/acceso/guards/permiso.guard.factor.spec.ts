import "reflect-metadata";
import { HttpException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { ContappDb } from "@contapp/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SesionResuelta } from "../../auth/auth.service.js";
import { fijarSesion, SinEstudio, type PeticionAuth } from "../../auth/guards/decoradores.js";
import { generarToken } from "../../auth/sesion/token.js";
import { rolExigeFactor } from "../../auth/totp/exigencia.js";
import { Permiso, SoloEstudio, SoloPlataforma } from "./decoradores.js";
import { PermisoGuard } from "./permiso.guard.js";

// 029 (T7) · exigencia del segundo factor en PermisoGuard (CA-4, U1–U2, D2) con dobles. Una sesión `verificado` no consulta la BD en
// `@SoloEstudio`; sin factor, Dueño y Administrador reciben 403 `segundo_factor_requerido`, los demás roles pasan; `@SoloPlataforma` lo
// exige siempre sin consultar.
const { miembroActual } = vi.hoisted(() => ({ miembroActual: vi.fn() }));
vi.mock("@contapp/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@contapp/db")>()),
  miembroActual: (...a: unknown[]) => miembroActual(...a),
}));

const T_A = "0190a000-0000-7000-8000-0000000000aa";
const reflector = new Reflector();
const withTenant = vi.fn(async (_ctx: unknown, fn: (t: unknown) => Promise<unknown>) => fn({}));
const guard = new PermisoGuard(reflector, { withTenant } as unknown as Pick<ContappDb, "withTenant">);
class Controlador {}

function sesion(factor: SesionResuelta["factor"]): SesionResuelta {
  return {
    token: generarToken(),
    sesionId: "s1",
    usuarioId: "u1",
    tenantActivo: T_A,
    estudioRevocado: false,
    factor,
    expiraAbsoluta: new Date(Date.now() + 3_600_000),
  };
}

function ctx(s: SesionResuelta, decorar: (fn: () => void) => void): ExecutionContext {
  const req: PeticionAuth = { method: "GET", headers: {} };
  fijarSesion(req, s);
  const handler = () => undefined;
  decorar(handler);
  return {
    getHandler: () => handler,
    getClass: () => Controlador,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
  } as unknown as ExecutionContext;
}

const soloEstudio = (fn: () => void) => SoloEstudio()(fn, "h", { value: fn });
const verClientes = (fn: () => void) => Permiso("clientes.ver")(fn, "h", { value: fn });
const plataforma = (fn: () => void) => {
  SinEstudio()(fn, "h", { value: fn });
  SoloPlataforma()(fn, "h", { value: fn });
};

async function codigo(p: Promise<boolean>): Promise<string> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(HttpException);
  return ((e as HttpException).getResponse() as { codigo: string }).codigo;
}

beforeEach(() => {
  miembroActual.mockReset();
  withTenant.mockClear();
});

describe("rolExigeFactor (U1–U2)", () => {
  it("Dueño y Administrador lo exigen; contador, asistente y lectura no; un rol fuera de la matriz lo exige (falla cerrado)", () => {
    expect(["dueno", "admin"].map(rolExigeFactor)).toEqual([true, true]);
    expect(["contador", "asistente", "lectura"].map(rolExigeFactor)).toEqual([false, false, false]);
    expect(rolExigeFactor("rol-desconocido")).toBe(true);
  });
});

describe("PermisoGuard · segundo factor", () => {
  it("@SoloEstudio con la sesión verificada pasa sin consultar la BD", async () => {
    await expect(guard.canActivate(ctx(sesion("verificado"), soloEstudio))).resolves.toBe(true);
    expect(withTenant).not.toHaveBeenCalled();
  });

  it("@SoloEstudio sin factor: Dueño 403 segundo_factor_requerido; contador pasa (lee el rol una vez)", async () => {
    miembroActual.mockResolvedValueOnce({ usuarioId: "u1", rol: "dueno" });
    expect(await codigo(guard.canActivate(ctx(sesion("sin_factor"), soloEstudio)))).toBe("segundo_factor_requerido");
    miembroActual.mockResolvedValueOnce({ usuarioId: "u1", rol: "contador" });
    await expect(guard.canActivate(ctx(sesion("sin_factor"), soloEstudio))).resolves.toBe(true);
    expect(withTenant).toHaveBeenCalledTimes(2);
  });

  it("@Permiso: Administrador sin factor 403 antes que el permiso; verificado pasa con el mismo rol", async () => {
    miembroActual.mockResolvedValue({ usuarioId: "u1", rol: "admin" });
    expect(await codigo(guard.canActivate(ctx(sesion("sin_factor"), verClientes)))).toBe("segundo_factor_requerido");
    await expect(guard.canActivate(ctx(sesion("verificado"), verClientes))).resolves.toBe(true);
  });

  it("@SoloPlataforma: sin factor 403 sin consultar; verificado pasa", async () => {
    expect(await codigo(guard.canActivate(ctx(sesion("sin_factor"), plataforma)))).toBe("segundo_factor_requerido");
    await expect(guard.canActivate(ctx(sesion("verificado"), plataforma))).resolves.toBe(true);
    expect(withTenant).not.toHaveBeenCalled();
  });

  it("@SoloEstudio sin factor y sin membresía activa: 403 estudio_requerido", async () => {
    miembroActual.mockResolvedValueOnce(null);
    expect(await codigo(guard.canActivate(ctx(sesion("sin_factor"), soloEstudio)))).toBe("estudio_requerido");
  });
});

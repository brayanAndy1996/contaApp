import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  miembroActual: vi.fn(),
}));

import { miembroActual } from "@contapp/db";
import type { SesionResuelta } from "../auth/auth.service.js";
import { AccesoError } from "./errores.js";
import { YoController } from "./yo.controller.js";

const TENANT = "0190a000-0000-7000-8000-0000000000a1";
const USUARIO = "0190a000-0000-7000-8000-0000000000b1";
const TX = { tx: true };

const sesion = { tenantActivo: TENANT, usuarioId: USUARIO } as SesionResuelta;

function armar() {
  const withTenant = vi.fn((_ctx: unknown, fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn(TX)),
  );
  return { withTenant, ctl: new YoController({ withTenant } as never) };
}

beforeEach(() => vi.mocked(miembroActual).mockReset());

describe("GET /acceso/yo", () => {
  it("lee la membresía dentro de withTenant del estudio activo y devuelve rol, permisos y alcance", async () => {
    vi.mocked(miembroActual).mockResolvedValue({ rol: "lectura" } as never);
    const { ctl, withTenant } = armar();
    const r = await ctl.yo(sesion);
    expect(withTenant).toHaveBeenCalledWith(
      { tenantId: TENANT, userId: USUARIO },
      expect.any(Function),
    );
    expect(miembroActual).toHaveBeenCalledWith(TX, USUARIO);
    expect(r.rol).toBe("lectura");
    expect(r.alcance).toBe("asignado");
    expect(r.permisos).toContain("clientes.ver");
    expect(r.permisos).not.toContain("usuarios.gestionar");
  });

  it("el Dueño tiene alcance global y el permiso de gestionar usuarios", async () => {
    vi.mocked(miembroActual).mockResolvedValue({ rol: "dueno" } as never);
    const r = await armar().ctl.yo(sesion);
    expect(r.alcance).toBe("global");
    expect(r.permisos).toContain("usuarios.gestionar");
  });

  it("sin membresía activa (revocada o desactivada tras resolver la sesión) -> 403 estudio_requerido", async () => {
    vi.mocked(miembroActual).mockResolvedValue(null);
    const { ctl } = armar();
    const error = await ctl.yo(sesion).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AccesoError);
    expect((error as AccesoError).codigo).toBe("estudio_requerido");
    expect((error as AccesoError).getStatus()).toBe(403);
  });
});

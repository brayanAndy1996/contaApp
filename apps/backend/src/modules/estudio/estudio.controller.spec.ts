import { describe, expect, it, vi } from "vitest";
import type { SesionResuelta } from "../auth/auth.service.js";
import { AuthError } from "../auth/errores.js";
import { EstudioController } from "./estudio.controller.js";

const T = "0190a000-0000-7000-8000-0000000000aa";
const U = "0190a000-0000-7000-8000-000000000001";

const sesion = { usuarioId: U, tenantActivo: T } as SesionResuelta;

function controlador(filas: { id: string; nombre: string }[]) {
  const withTenant = vi.fn(async (_ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn({ orm: { select: () => ({ from: async () => filas }) } }),
  );
  return { c: new EstudioController({ withTenant } as never), withTenant };
}

describe("GET /estudio/actual", () => {
  it("devuelve solo id y nombre del estudio activo, consultando dentro de withTenant", async () => {
    const { c, withTenant } = controlador([{ id: T, nombre: "Estudio A" }]);
    expect(await c.actual(sesion)).toEqual({ id: T, nombre: "Estudio A" });
    expect(withTenant).toHaveBeenCalledWith({ tenantId: T, userId: U }, expect.any(Function));
  });

  it("si la RLS no deja ver el estudio responde estudio_requerido", async () => {
    const { c } = controlador([]);
    await expect(c.actual(sesion)).rejects.toMatchObject({ codigo: "estudio_requerido" });
    await expect(c.actual(sesion)).rejects.toBeInstanceOf(AuthError);
  });
});

// Spec 030 (T14): comportamiento público de `RolesService` que `roles.service.spec.ts` no ejercita, sin BD: el reintento de DELETE
// cuando el 23503 ya no se explica con los conteos (carrera), y `impacto` de quien ya no es miembro o tiene un rol propio sin definición.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  eliminarRol: vi.fn(),
  impactoRol: vi.fn(),
  leerRol: vi.fn(),
  miembroActual: vi.fn(),
  usoRol: vi.fn(),
}));

import { AccesoRepoError, eliminarRol, impactoRol, leerRol, miembroActual, usoRol } from "@contapp/db";
import { AccesoError } from "../errores.js";
import { RolesService } from "./roles.service.js";

const L = { tenantId: "0190a000-0000-7000-8000-0000000000a1", usuarioId: "0190a000-0000-7000-8000-0000000000b1" };
const ID = "0190a000-0000-7000-8000-0000000000c1";

const servicio = (): RolesService =>
  new RolesService({ withTenant: (_ctx: unknown, fn: (tx: unknown) => unknown) => Promise.resolve(fn({ tx: true })) } as never);
const enUso = () => new AccesoRepoError("23503");

beforeEach(() => {
  vi.resetAllMocks();
});

describe("RolesService.eliminar · 23503 sin explicación en los conteos", () => {
  it("si entre la transacción abortada y la lectura de conteos lo que bloqueaba desapareció, reintenta y borra sin error", async () => {
    vi.mocked(eliminarRol).mockRejectedValueOnce(enUso()).mockResolvedValueOnce(undefined);
    vi.mocked(usoRol).mockResolvedValueOnce({ miembros: 0, invitaciones: 0 });
    await expect(servicio().eliminar(L, ID)).resolves.toBeUndefined();
    expect(eliminarRol).toHaveBeenCalledTimes(2);
    expect(usoRol).toHaveBeenCalledTimes(1);
  });

  it("con miembros o invitaciones vigentes responde 409 rol_en_uso con los conteos y sin reintentar", async () => {
    vi.mocked(eliminarRol).mockRejectedValue(enUso());
    vi.mocked(usoRol).mockResolvedValue({ miembros: 2, invitaciones: 1 });
    const e = await servicio().eliminar(L, ID).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AccesoError);
    expect((e as AccesoError).cuerpo).toEqual({ codigo: "rol_en_uso", miembros: 2, invitaciones: 1 });
    expect(eliminarRol).toHaveBeenCalledTimes(1);
  });

  it("solo invitaciones vigentes también bloquean (conteo de miembros en cero)", async () => {
    vi.mocked(eliminarRol).mockRejectedValue(enUso());
    vi.mocked(usoRol).mockResolvedValue({ miembros: 0, invitaciones: 3 });
    await expect(servicio().eliminar(L, ID)).rejects.toMatchObject({ codigo: "rol_en_uso" });
    expect(eliminarRol).toHaveBeenCalledTimes(1);
  });

  it("tras 3 intentos con el 23503 persistiendo y conteos en cero, deja de reintentar y responde rol_en_uso (no itera sin fin)", async () => {
    vi.mocked(eliminarRol).mockRejectedValue(enUso());
    vi.mocked(usoRol).mockResolvedValue({ miembros: 0, invitaciones: 0 });
    const e = await servicio().eliminar(L, ID).catch((x: unknown) => x);
    expect((e as AccesoError).cuerpo).toEqual({ codigo: "rol_en_uso", miembros: 0, invitaciones: 0 });
    expect(eliminarRol).toHaveBeenCalledTimes(3);
    expect(usoRol).toHaveBeenCalledTimes(3);
  });

  it("un error distinto del 23503 en un reintento sale traducido y no cuenta como uso", async () => {
    vi.mocked(eliminarRol).mockRejectedValueOnce(enUso()).mockRejectedValueOnce(new AccesoRepoError("P0002"));
    vi.mocked(usoRol).mockResolvedValueOnce({ miembros: 0, invitaciones: 0 });
    await expect(servicio().eliminar(L, ID)).rejects.toMatchObject({ codigo: "no_encontrado" });
  });
});

describe("RolesService.impacto · actor sin membresía o sin definición", () => {
  const rol = { id: ID, nombre: "R", alcance: "asignado" as const, permisos: ["clientes.ver"] };

  it("quien ya no es miembro activo recibe estudio_requerido y no se cuenta nada", async () => {
    vi.mocked(leerRol).mockResolvedValue(rol);
    vi.mocked(miembroActual).mockResolvedValue(null);
    await expect(servicio().impacto(L, ID, { alcance: "global" })).rejects.toMatchObject({ codigo: "estudio_requerido" });
    expect(impactoRol).not.toHaveBeenCalled();
  });

  it("un actor con rol propio sin definición se resuelve al mínimo: no contiene al rol y recibe escalada", async () => {
    vi.mocked(leerRol).mockResolvedValue(rol);
    vi.mocked(miembroActual).mockResolvedValue({ usuarioId: L.usuarioId, rol: "propio", rolId: null, propio: null });
    await expect(servicio().impacto(L, ID, { nombre: "X" })).rejects.toMatchObject({ codigo: "escalada" });
    expect(impactoRol).not.toHaveBeenCalled();
  });
});

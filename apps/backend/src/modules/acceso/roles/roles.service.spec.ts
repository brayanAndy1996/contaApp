import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  bloquearRoles: vi.fn(),
  eliminarRol: vi.fn(),
  guardarRol: vi.fn(),
  impactoRol: vi.fn(),
  leerRol: vi.fn(),
  listarRoles: vi.fn(),
  miembroActual: vi.fn(),
  usoRol: vi.fn(),
}));

import {
  AccesoRepoError,
  eliminarRol,
  guardarRol,
  leerRol,
  listarRoles,
  miembroActual,
} from "@contapp/db";
import { AccesoError } from "../errores.js";
import { RolesService } from "./roles.service.js";

const L = { tenantId: "0190a000-0000-7000-8000-0000000000a1", usuarioId: "0190a000-0000-7000-8000-0000000000b1" };
const ID = "0190a000-0000-7000-8000-0000000000c1";
const TX = { tx: true };

const servicio = (): RolesService =>
  new RolesService({ withTenant: (_ctx: unknown, fn: (tx: unknown) => unknown) => Promise.resolve(fn(TX)) } as never);

beforeEach(() => {
  vi.mocked(guardarRol).mockReset();
  vi.mocked(leerRol).mockReset();
  vi.mocked(eliminarRol).mockReset();
  vi.mocked(listarRoles).mockReset();
  vi.mocked(miembroActual).mockReset();
});

describe("RolesService · ramas que el HTTP no alcanza", () => {
  it("crear con un baseRolId que no es de este estudio: 404 y no escribe", async () => {
    vi.mocked(leerRol).mockResolvedValue(null);
    const r = servicio().crear(L, { nombre: "N", alcance: "global", permisos: [], baseRolId: ID });
    await expect(r).rejects.toMatchObject({ codigo: "no_encontrado" });
    expect(guardarRol).not.toHaveBeenCalled();
  });

  it("un SQLSTATE sin traducción sale tal cual (el filtro global lo vuelve 500 sin detalles) y un error ajeno también", async () => {
    const desconocido = new AccesoRepoError("XX000");
    vi.mocked(guardarRol).mockRejectedValueOnce(desconocido);
    await expect(servicio().crear(L, { nombre: "N", alcance: "global", permisos: [] })).rejects.toBe(desconocido);
    const ajeno = new Error("otro");
    vi.mocked(guardarRol).mockRejectedValueOnce(ajeno);
    await expect(servicio().crear(L, { nombre: "N", alcance: "global", permisos: [] })).rejects.toBe(ajeno);
    vi.mocked(eliminarRol).mockRejectedValueOnce(desconocido);
    await expect(servicio().eliminar(L, ID)).rejects.toBe(desconocido);
  });

  it("los SQLSTATE de las funciones de 0082 salen como códigos fijos", async () => {
    const casos: Array<[string, string]> = [
      ["42501", "escalada"],
      ["RL001", "rol_propio"],
      ["54000", "limite_roles"],
      ["23505", "nombre_duplicado"],
      ["23514", "nombre_duplicado"],
      ["P0002", "no_encontrado"],
    ];
    for (const [sqlstate, codigo] of casos) {
      vi.mocked(eliminarRol).mockRejectedValueOnce(new AccesoRepoError(sqlstate));
      const e = await servicio().eliminar(L, ID).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(AccesoError);
      expect(e).toMatchObject({ codigo });
    }
  });

  it("editar sin ningún campo: 400 solicitud_invalida y no toca la BD", async () => {
    await expect(servicio().editar(L, ID, {})).rejects.toMatchObject({ codigo: "solicitud_invalida" });
    expect(leerRol).not.toHaveBeenCalled();
  });

  it("asignables sin membresía activa: 403 estudio_requerido; un rol propio sin definición se resuelve al mínimo (sin permisos, alcance asignado)", async () => {
    vi.mocked(miembroActual).mockResolvedValueOnce(null);
    await expect(servicio().asignables(L)).rejects.toMatchObject({ codigo: "estudio_requerido" });
    vi.mocked(miembroActual).mockResolvedValueOnce({ usuarioId: L.usuarioId, rol: "propio", rolId: ID, propio: null });
    vi.mocked(listarRoles).mockResolvedValueOnce([
      { id: ID, nombre: "Vacío", alcance: "asignado", permisos: [], miembros: 0, invitaciones: 0 },
    ]);
    // Sin permisos y de alcance asignado: de los de sistema ninguno cabe; el propio vacío sí.
    await expect(servicio().asignables(L)).resolves.toEqual({ sistema: [], propios: [{ id: ID, nombre: "Vacío" }] });
  });
});

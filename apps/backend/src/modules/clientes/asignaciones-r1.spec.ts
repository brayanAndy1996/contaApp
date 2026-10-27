// Spec 005 · T15 (H-005-1b-4): las asignaciones releen y bloquean al actor dentro de su transacción (D3). Sin BD:
// los repositorios de @contapp/db se sustituyen con vi.mock; la carrera real está en acceso-r1b.adv.int.spec.ts.
import type { MiembroEstado } from "@contapp/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SesionResuelta } from "../auth/auth.service.js";
import { AsignacionesService, exigirAsignador } from "./asignaciones.service.js";

const db = vi.hoisted(() => ({
  bloquearMiembro: vi.fn(),
  asignar: vi.fn(),
  retirar: vi.fn(),
  asignarPorUsuario: vi.fn(),
  asignarPorCliente: vi.fn(),
}));
vi.mock("@contapp/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@contapp/db")>()),
  ...db,
}));

const ACTOR = "0190a000-0000-7000-8000-0000000000a1";
const OBJ = "0190a000-0000-7000-8000-0000000000b2";
const CLIENTE = "0190a000-0000-7000-8000-0000000000c3";
const TENANT = "0190a000-0000-7000-8000-0000000000d4";
const sesion = { usuarioId: ACTOR, tenantActivo: TENANT } as SesionResuelta;
const tx = { query: vi.fn() };
const servicio = () => new AsignacionesService({ withTenant: (_c: unknown, fn: (t: unknown) => unknown) => fn(tx) } as never);
const miembro = (usuarioId: string, rol: string, activo = true): MiembroEstado =>
  ({ usuarioId, rol, activo }) as MiembroEstado;

/** El actor tiene `rolActor`; el objetivo es un contador activo. */
function miembros(rolActor: string, activo = true) {
  db.bloquearMiembro.mockImplementation(async (_t: unknown, id: string) =>
    id === ACTOR ? miembro(ACTOR, rolActor, activo) : miembro(id, "contador"),
  );
}

const acciones: Array<[string, (s: AsignacionesService) => Promise<unknown>, keyof typeof db]> = [
  ["asignar", (s) => s.asignar(sesion, CLIENTE, OBJ, { tipo: "colaborador" }), "asignar"],
  ["retirar", (s) => s.retirar(sesion, CLIENTE, OBJ), "retirar"],
  ["porUsuario", (s) => s.porUsuario(sesion, { usuarioId: OBJ, clienteIds: [CLIENTE], tipo: "colaborador" }), "asignarPorUsuario"],
  ["porCliente", (s) => s.porCliente(sesion, { clienteId: CLIENTE, usuarioIds: [OBJ] }), "asignarPorCliente"],
];

beforeEach(() => {
  vi.clearAllMocks();
  db.asignar.mockResolvedValue([]);
  db.retirar.mockResolvedValue(true);
  db.asignarPorUsuario.mockResolvedValue({ asignados: 1 });
  db.asignarPorCliente.mockResolvedValue({ asignados: 1 });
});

describe("H-005-1b-4 · actor releído en la transacción de la asignación", () => {
  it.each(acciones)("%s: actor degradado a Lectura -> 403 permiso_denegado sin escribir", async (_n, llamar, repo) => {
    miembros("lectura");
    await expect(llamar(servicio())).rejects.toMatchObject({ codigo: "permiso_denegado" });
    expect(db[repo]).not.toHaveBeenCalled();
  });

  it.each(acciones)("%s: actor desactivado -> 403 estudio_requerido sin escribir", async (_n, llamar, repo) => {
    miembros("admin", false);
    await expect(llamar(servicio())).rejects.toMatchObject({ codigo: "estudio_requerido" });
    expect(db[repo]).not.toHaveBeenCalled();
  });

  it.each(acciones)("%s: actor Administrador activo -> escribe", async (_n, llamar, repo) => {
    miembros("admin");
    await llamar(servicio());
    expect(db[repo]).toHaveBeenCalledTimes(1);
    expect(db.bloquearMiembro).toHaveBeenCalledWith(tx, ACTOR);
  });

  it("bloquea actor y objetivo en orden de ID (también con el objetivo en mayúsculas) y una sola vez si son el mismo", async () => {
    miembros("dueno");
    await servicio().asignar(sesion, CLIENTE, OBJ.toUpperCase(), { tipo: "colaborador" });
    expect(db.bloquearMiembro.mock.calls.map((c) => c[1])).toEqual([ACTOR, OBJ]);

    vi.clearAllMocks();
    const alReves = { ...sesion, usuarioId: OBJ } as SesionResuelta;
    db.bloquearMiembro.mockImplementation(async (_t: unknown, id: string) => miembro(id, "dueno"));
    db.asignar.mockResolvedValue([]);
    await servicio().asignar(alReves, CLIENTE, ACTOR, { tipo: "colaborador" });
    expect(db.bloquearMiembro.mock.calls.map((c) => c[1])).toEqual([ACTOR, OBJ]);

    vi.clearAllMocks();
    db.bloquearMiembro.mockImplementation(async (_t: unknown, id: string) => miembro(id, "dueno"));
    db.asignar.mockResolvedValue([]);
    await servicio().asignar(sesion, CLIENTE, ACTOR, { tipo: "responsable" });
    expect(db.bloquearMiembro.mock.calls.map((c) => c[1])).toEqual([ACTOR]);
  });

  it("exigirAsignador: null o desactivado -> estudio_requerido; sin clientes.asignar -> permiso_denegado; Dueño pasa", () => {
    expect(() => exigirAsignador(null)).toThrow(expect.objectContaining({ codigo: "estudio_requerido" }));
    expect(() => exigirAsignador(miembro(ACTOR, "dueno", false))).toThrow(
      expect.objectContaining({ codigo: "estudio_requerido" }),
    );
    expect(() => exigirAsignador(miembro(ACTOR, "contador"))).toThrow(expect.objectContaining({ codigo: "permiso_denegado" }));
    expect(() => exigirAsignador(miembro(ACTOR, "dueno"))).not.toThrow();
  });
});

// Spec 005 · T17 (H-005-2a-1, H-005-2b-1): el servicio bloquea al actor y a TODOS los miembros de la acción en una
// sola llamada a `bloquearMiembros` (una sentencia ordenada por usuario_id) antes de tocar clientes. Sin BD: los
// repositorios se sustituyen con vi.mock; las carreras reales están en asignaciones-r2.int.spec.ts.
import type { MiembroEstado } from "@contapp/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SesionResuelta } from "../auth/auth.service.js";
import { AsignacionesService } from "./asignaciones.service.js";

const db = vi.hoisted(() => ({
  bloquearMiembros: vi.fn(),
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
const U1 = "0190a000-0000-7000-8000-0000000000b2";
const U2 = "0190a000-0000-7000-8000-0000000000b3";
const CLIENTE = "0190a000-0000-7000-8000-0000000000c3";
const sesion = { usuarioId: ACTOR, tenantActivo: ACTOR } as SesionResuelta;
const tx = { query: vi.fn() };
const servicio = () => new AsignacionesService({ withTenant: (_c: unknown, fn: (t: unknown) => unknown) => fn(tx) } as never);
const orden: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  orden.length = 0;
  db.bloquearMiembros.mockImplementation(async (_t: unknown, ids: string[]) => {
    orden.push("miembros");
    return new Map(
      ids.map((id) => [id.toLowerCase(), { usuarioId: id.toLowerCase(), rol: id === ACTOR ? "admin" : "contador", activo: true } as MiembroEstado]),
    );
  });
  for (const [k, v] of [
    ["asignar", []],
    ["retirar", true],
    ["asignarPorUsuario", { asignados: 1 }],
    ["asignarPorCliente", { asignados: 2 }],
  ] as const)
    db[k].mockImplementation(async () => {
      orden.push(k);
      return v;
    });
});

describe("T17 · orden global de bloqueo en el servicio de asignaciones", () => {
  it("por-cliente: actor y todos los miembros en UNA llamada, antes del repositorio", async () => {
    expect(await servicio().porCliente(sesion, { clienteId: CLIENTE, usuarioIds: [U2, U1] })).toEqual({ asignados: 2 });
    expect(db.bloquearMiembros).toHaveBeenCalledTimes(1);
    expect(db.bloquearMiembros.mock.calls[0]![1]).toEqual([ACTOR, U2, U1]);
    expect(orden).toEqual(["miembros", "asignarPorCliente"]);
  });

  it("retirar: actor y objetivo en una llamada, antes de borrar", async () => {
    await servicio().retirar(sesion, CLIENTE, U1);
    expect(db.bloquearMiembros.mock.calls.map((c) => c[1])).toEqual([[ACTOR, U1]]);
    expect(orden).toEqual(["miembros", "retirar"]);
  });

  it("por-usuario: actor y objetivo (en minúsculas) en una llamada, antes del repositorio", async () => {
    await servicio().porUsuario(sesion, { usuarioId: U1.toUpperCase(), clienteIds: [CLIENTE], tipo: "colaborador" });
    expect(db.bloquearMiembros.mock.calls.map((c) => c[1])).toEqual([[ACTOR, U1]]);
    expect(orden).toEqual(["miembros", "asignarPorUsuario"]);
  });

  it("error: objetivo que no es del estudio -> 404 no_encontrado sin llegar al repositorio", async () => {
    db.bloquearMiembros.mockImplementation(async () => new Map([[ACTOR, { usuarioId: ACTOR, rol: "admin", activo: true }]]));
    await expect(servicio().asignar(sesion, CLIENTE, U1, { tipo: "colaborador" })).rejects.toMatchObject({
      codigo: "no_encontrado",
    });
    expect(db.asignar).not.toHaveBeenCalled();
  });
});

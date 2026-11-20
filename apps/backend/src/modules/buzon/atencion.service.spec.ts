// Spec 024 (T8): la atención sin BD. Mapeo de los errores de la función acotada, reintento único y visibilidad del lote.
import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  aplicarAtencionBuzon: vi.fn(),
  detalleAtencion: vi.fn(),
  clienteVisible: vi.fn(),
}));

import { aplicarAtencionBuzon, BuzonRepoError, clienteVisible, detalleAtencion } from "@contapp/db";
import type { SesionResuelta } from "../auth/auth.service.js";
import { AtencionBuzonService } from "./atencion.service.js";

const T = "0190a000-0000-7000-8000-0000000000a1";
const U = "0190a000-0000-7000-8000-0000000000b1";
const C = "0190a000-0000-7000-8000-0000000000c1";
const M1 = "0190a000-0000-7000-8000-0000000000d1";
const M2 = "0190a000-0000-7000-8000-0000000000d2";
const sesion = { tenantActivo: T, usuarioId: U } as SesionResuelta;
const global = { tipo: "global" } as const;
const asignado = { tipo: "asignado", usuarioId: U } as const;
const DETALLE = { estado: "atendido", por: { id: U, nombre: "Ana" }, en: new Date("2026-11-12T15:00:00Z"), comentario: "ok", historial: [] };

let consultas: unknown[][];
function armar(filas: { cliente_id: string; n: number }[] = [{ cliente_id: C, n: 1 }]) {
  const tx = { query: vi.fn(async (_t: string, v: unknown[]) => (consultas.push(v), { rows: filas })) };
  const withTenant = vi.fn((_c: unknown, fn: (tx: unknown) => unknown) => Promise.resolve(fn(tx)));
  return { withTenant, servicio: new AtencionBuzonService({ withTenant } as never) };
}
const codigo = async (p: Promise<unknown>): Promise<unknown> => p.then(() => "ok", (e: { codigo?: string }) => e.codigo);
const aplicado = (id: string, ok: boolean) => ({ mensajeId: id, aplicado: ok, atendidoPor: null, atendidoEn: null });

beforeEach(() => {
  consultas = [];
  vi.resetAllMocks();
  vi.mocked(clienteVisible).mockResolvedValue(true);
  vi.mocked(detalleAtencion).mockResolvedValue(DETALLE as never);
});

describe("atender (individual)", () => {
  it("marca y devuelve el estado resultante; pasa el cliente de la ruta a la función", async () => {
    vi.mocked(aplicarAtencionBuzon).mockResolvedValue([aplicado(M1, true)]);
    const r = await armar().servicio.atender(sesion, global, C, M1.toUpperCase(), { accion: "marcar", comentario: " ok " });
    expect(r).toEqual({ cambiada: false, atencion: expect.objectContaining({ estado: "atendido", comentario: "ok" }) });
    expect(aplicarAtencionBuzon).toHaveBeenCalledWith(expect.anything(), { accion: "marcar", mensajes: [M1], clienteId: C, comentario: "ok" });
  });

  it("aplicado=false es `cambiada` con el estado vigente (el controlador lo vuelve 409)", async () => {
    vi.mocked(aplicarAtencionBuzon).mockResolvedValue([aplicado(M1, false)]);
    expect((await armar().servicio.atender(sesion, global, C, M1, { accion: "deshacer" })).cambiada).toBe(true);
  });

  it.each([
    ["P0002", "no_encontrado"],
    ["55000", "cliente_archivado"],
    ["22004", "comentario_requerido"],
    ["22023", "solicitud_invalida"],
    ["42501", "permiso_denegado"],
  ])("el SQLSTATE %s de la función es %s", async (sqlstate, esperado) => {
    vi.mocked(aplicarAtencionBuzon).mockRejectedValue(new BuzonRepoError(sqlstate));
    expect(await codigo(armar().servicio.atender(sesion, global, C, M1, { accion: "marcar" }))).toBe(esperado);
  });

  it("un error que no es de la función se propaga tal cual (500 sin eco)", async () => {
    const raro = new BuzonRepoError("XX000");
    vi.mocked(aplicarAtencionBuzon).mockRejectedValue(raro);
    await expect(armar().servicio.atender(sesion, global, C, M1, { accion: "marcar" })).rejects.toBe(raro);
  });

  it("cuerpo inválido es 400 sin abrir transacción; ids mal formados son 404", async () => {
    const { servicio, withTenant } = armar();
    for (const cuerpo of [undefined, {}, { accion: "archivar" }, { accion: "marcar", extra: 1 }, { accion: "marcar", comentario: "" }]) {
      expect(await codigo(servicio.atender(sesion, global, C, M1, cuerpo))).toBe("solicitud_invalida");
    }
    expect(await codigo(servicio.atender(sesion, global, "x", M1, { accion: "marcar" }))).toBe("no_encontrado");
    expect(await codigo(servicio.atender(sesion, global, C, "x", { accion: "marcar" }))).toBe("no_encontrado");
    expect(withTenant).not.toHaveBeenCalled();
  });

  it("un cliente no visible dentro de la transacción es 404 y no llama a la función", async () => {
    vi.mocked(clienteVisible).mockResolvedValue(false);
    expect(await codigo(armar().servicio.atender(sesion, asignado, C, M1, { accion: "marcar" }))).toBe("no_encontrado");
    expect(aplicarAtencionBuzon).not.toHaveBeenCalled();
  });

  it("reintenta una vez un interbloqueo y responde 503 si vuelve a ocurrir", async () => {
    vi.mocked(aplicarAtencionBuzon)
      .mockRejectedValueOnce(new BuzonRepoError("40P01"))
      .mockResolvedValueOnce([aplicado(M1, true)]);
    const { servicio, withTenant } = armar();
    expect((await servicio.atender(sesion, global, C, M1, { accion: "marcar" })).cambiada).toBe(false);
    expect(withTenant).toHaveBeenCalledTimes(2);
    vi.mocked(aplicarAtencionBuzon).mockRejectedValue(new BuzonRepoError("40001"));
    expect(await codigo(servicio.atender(sesion, global, C, M1, { accion: "marcar" }))).toBe("atenciones_ocupadas");
  });
});

describe("atenderLote", () => {
  it("separa atendidos y omitidos en el orden pedido y llama a la función sin cliente (lote)", async () => {
    vi.mocked(aplicarAtencionBuzon).mockResolvedValue([aplicado(M1, false), aplicado(M2, true)]);
    const r = await armar([{ cliente_id: C, n: 2 }]).servicio.atenderLote(sesion, global, { mensajes: [M2, M1] });
    expect(r).toEqual({ atendidos: [M2], omitidos: [M1] });
    expect(aplicarAtencionBuzon).toHaveBeenCalledWith(expect.anything(), { accion: "marcar", mensajes: [M2, M1] });
  });

  it("un id que no existe en el estudio (cuenta distinta) es 404 sin llamar a la función", async () => {
    expect(await codigo(armar([{ cliente_id: C, n: 1 }]).servicio.atenderLote(sesion, global, { mensajes: [M1, M2] }))).toBe("no_encontrado");
    expect(aplicarAtencionBuzon).not.toHaveBeenCalled();
  });

  it("un cliente no visible con el alcance asignado es 404", async () => {
    vi.mocked(clienteVisible).mockResolvedValue(false);
    expect(await codigo(armar().servicio.atenderLote(sesion, asignado, { mensajes: [M1] }))).toBe("no_encontrado");
    expect(aplicarAtencionBuzon).not.toHaveBeenCalled();
  });

  it.each([
    [{ mensajes: [] }],
    [{ mensajes: [M1, M1.toUpperCase()] }],
    [{ mensajes: [M1], accion: "deshacer" }],
    [{ mensajes: [M1], clienteId: C }],
    [{ mensajes: [M1], comentario: "a\u0000b" }],
  ])("cuerpo inválido %j es 400", async (cuerpo) => {
    const { servicio, withTenant } = armar();
    expect(await codigo(servicio.atenderLote(sesion, global, cuerpo))).toBe("solicitud_invalida");
    expect(withTenant).not.toHaveBeenCalled();
  });

  it("los errores de la función se traducen igual que en la ruta individual", async () => {
    vi.mocked(aplicarAtencionBuzon).mockRejectedValue(new BuzonRepoError("22004"));
    expect(await codigo(armar().servicio.atenderLote(sesion, global, { mensajes: [M1] }))).toBe("comentario_requerido");
    vi.mocked(aplicarAtencionBuzon).mockRejectedValue(new BuzonRepoError("55000"));
    expect(await codigo(armar().servicio.atenderLote(sesion, global, { mensajes: [M1] }))).toBe("cliente_archivado");
  });
});

// Spec 028 (T12): `PreferenciasService` sin BD. Traducción de SQLSTATE (42501, CA430, 22023), reintento único ante 40P01/40001 con 503 al
// segundo fallo, cuerpos inválidos sin tocar la BD y la vista de nueve claves.
import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  fijarPreferencias: vi.fn(),
  leerPreferencias: vi.fn(),
}));

import { fijarPreferencias, leerPreferencias, type PreferenciasLeidas } from "@contapp/db";
import { PreferenciasService } from "./preferencias.service.js";

const SESION = { tenantActivo: "0190a000-0000-7000-8000-0000000000a1", usuarioId: "0190a000-0000-7000-8000-0000000000b1" } as never;
const SIN_ESTUDIO = { tenantActivo: null, usuarioId: "0190a000-0000-7000-8000-0000000000b1" } as never;
const withTenant = vi.fn((_ctx: unknown, f: (t: unknown) => Promise<unknown>) => f({ tx: 1 }));
const servicio = () => new PreferenciasService({ withTenant } as never);
const CUERPO = { buzonCritico: true, credencialInvalida: true, planLimite: false, resumen: true, todosClientes: false };
const LEIDAS: PreferenciasLeidas = {
  ...CUERPO,
  todosDisponible: true,
  todosIgnorado: false,
  invitacionResumen: false,
  ultimoEnvioFallido: new Date("2026-11-24T10:00:00.000Z"),
};
const error = (codigo: string) => Object.assign(new Error("x"), { codigo });
const fallo = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { codigo?: string; getStatus(): number; getResponse(): unknown });

beforeEach(() => {
  vi.mocked(leerPreferencias).mockReset();
  vi.mocked(fijarPreferencias).mockReset();
  withTenant.mockClear();
});

describe("leer", () => {
  it("devuelve la vista de nueve claves con la fecha del último fallo en ISO", async () => {
    vi.mocked(leerPreferencias).mockResolvedValue(LEIDAS);
    const v = await servicio().leer(SESION);
    expect(Object.keys(v).sort()).toHaveLength(9);
    expect(v).toMatchObject({ resumen: true, ultimoEnvioFallido: "2026-11-24T10:00:00.000Z", todosDisponible: true });
    expect(withTenant).toHaveBeenCalledWith({ tenantId: "0190a000-0000-7000-8000-0000000000a1", userId: "0190a000-0000-7000-8000-0000000000b1" }, expect.any(Function));
  });

  it("sin fallo previo la fecha es null", async () => {
    vi.mocked(leerPreferencias).mockResolvedValue({ ...LEIDAS, ultimoEnvioFallido: null });
    expect((await servicio().leer(SESION)).ultimoEnvioFallido).toBeNull();
  });

  it("42501 es 403 permiso_denegado; un error desconocido sale tal cual", async () => {
    vi.mocked(leerPreferencias).mockRejectedValueOnce(error("42501"));
    const e = await fallo(servicio().leer(SESION));
    expect(e?.getStatus()).toBe(403);
    expect(e?.getResponse()).toEqual({ codigo: "permiso_denegado" });
    const raro = new Error("otro");
    vi.mocked(leerPreferencias).mockRejectedValueOnce(raro);
    expect(await fallo(servicio().leer(SESION))).toBe(raro);
  });

  it("sin estudio activo es 403 sin tocar la BD", async () => {
    const e = await fallo(servicio().leer(SIN_ESTUDIO));
    expect(e?.getStatus()).toBe(403);
    expect(withTenant).not.toHaveBeenCalled();
  });
});

describe("guardar", () => {
  it("cuerpo inválido: 400 sin tocar la BD", async () => {
    for (const cuerpo of [null, {}, { ...CUERPO, extra: 1 }, { ...CUERPO, resumen: "si" }]) {
      const e = await fallo(servicio().guardar(SESION, cuerpo));
      expect(e?.getStatus()).toBe(400);
    }
    expect(withTenant).not.toHaveBeenCalled();
  });

  it("guarda y devuelve la vista", async () => {
    vi.mocked(fijarPreferencias).mockResolvedValue(LEIDAS);
    expect((await servicio().guardar(SESION, CUERPO)).resumen).toBe(true);
    expect(fijarPreferencias).toHaveBeenCalledWith({ tx: 1 }, CUERPO);
  });

  it("CA430 es 409 todos_clientes_no_disponible, 42501 es 403 y 22023 es 400", async () => {
    for (const [codigo, estado, cuerpo] of [
      ["CA430", 409, { codigo: "todos_clientes_no_disponible" }],
      ["42501", 403, { codigo: "permiso_denegado" }],
      ["22023", 400, { codigo: "solicitud_invalida" }],
    ] as const) {
      vi.mocked(fijarPreferencias).mockRejectedValueOnce(error(codigo));
      const e = await fallo(servicio().guardar(SESION, CUERPO));
      expect(e?.getStatus()).toBe(estado);
      expect(e?.getResponse()).toEqual(cuerpo);
    }
  });

  it("un interbloqueo o fallo de serialización se reintenta una vez", async () => {
    for (const codigo of ["40P01", "40001"]) {
      vi.mocked(fijarPreferencias).mockReset();
      vi.mocked(fijarPreferencias).mockRejectedValueOnce(error(codigo)).mockResolvedValueOnce(LEIDAS);
      expect((await servicio().guardar(SESION, CUERPO)).resumen).toBe(true);
      expect(fijarPreferencias).toHaveBeenCalledTimes(2);
    }
  });

  it("si el reintento también choca: 503 correo_ocupado; otro error en el reintento sale traducido", async () => {
    vi.mocked(fijarPreferencias).mockRejectedValue(error("40P01"));
    const e = await fallo(servicio().guardar(SESION, CUERPO));
    expect(e?.getStatus()).toBe(503);
    expect(e?.getResponse()).toEqual({ codigo: "correo_ocupado" });
    expect(fijarPreferencias).toHaveBeenCalledTimes(2);
    vi.mocked(fijarPreferencias).mockReset();
    vi.mocked(fijarPreferencias).mockRejectedValueOnce(error("40001")).mockRejectedValueOnce(error("CA430"));
    expect((await fallo(servicio().guardar(SESION, CUERPO)))?.getStatus()).toBe(409);
  });
});

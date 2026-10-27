import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  listarClientes: vi.fn(),
  leerCliente: vi.fn(),
}));

import { leerCliente, listarClientes } from "@contapp/db";
import type { SesionResuelta } from "../auth/auth.service.js";
import type { PeticionAcceso } from "../acceso/guards/decoradores.js";
import { ClientesController } from "./clientes.controller.js";

const TENANT = "0190a000-0000-7000-8000-0000000000a1";
const USUARIO = "0190a000-0000-7000-8000-0000000000b1";
const CLIENTE = "0190a000-0000-7000-8000-0000000000c1";
const TX = { tx: true };

const sesion = (tenantActivo: string | null) =>
  ({ tenantActivo, usuarioId: USUARIO }) as SesionResuelta;
const peticion = (alcance: "global" | "asignado" | null) =>
  ({
    acceso:
      alcance === null
        ? undefined
        : { usuarioId: USUARIO, rol: "x", permisos: new Set(), alcance },
  }) as unknown as PeticionAcceso;

function armar() {
  const withTenant = vi.fn((_ctx: unknown, fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn(TX)),
  );
  return { withTenant, ctl: new ClientesController({ withTenant } as never) };
}

beforeEach(() => {
  vi.mocked(listarClientes).mockReset();
  vi.mocked(leerCliente).mockReset();
});

describe("GET /clientes", () => {
  it("alcance global: listarClientes con alcance global dentro de withTenant", async () => {
    vi.mocked(listarClientes).mockResolvedValue([{ id: CLIENTE }] as never);
    const { ctl, withTenant } = armar();
    const r = await ctl.listar(sesion(TENANT), peticion("global"));
    expect(withTenant).toHaveBeenCalledWith(
      { tenantId: TENANT, userId: USUARIO },
      expect.any(Function),
    );
    expect(listarClientes).toHaveBeenCalledWith(TX, { tipo: "global" });
    expect(r).toEqual([{ id: CLIENTE }]);
  });

  it("alcance asignado: filtra por el usuario del actor", async () => {
    vi.mocked(listarClientes).mockResolvedValue([]);
    await armar().ctl.listar(sesion(TENANT), peticion("asignado"));
    expect(listarClientes).toHaveBeenCalledWith(TX, {
      tipo: "asignado",
      usuarioId: USUARIO,
    });
  });

  it("sin acceso en la petición falla cerrado (permiso_denegado) sin consultar la BD", () => {
    const { ctl, withTenant } = armar();
    expect(() => ctl.listar(sesion(TENANT), peticion(null))).toThrowError(
      expect.objectContaining({ codigo: "permiso_denegado" }),
    );
    expect(withTenant).not.toHaveBeenCalled();
  });

  it("sin estudio activo falla con estudio_requerido sin consultar la BD", () => {
    const { ctl, withTenant } = armar();
    expect(() => ctl.listar(sesion(null), peticion("global"))).toThrowError(
      expect.objectContaining({ codigo: "estudio_requerido" }),
    );
    expect(withTenant).not.toHaveBeenCalled();
  });
});

describe("GET /clientes/:clienteId", () => {
  it("cliente visible: lo devuelve", async () => {
    vi.mocked(leerCliente).mockResolvedValue({ id: CLIENTE } as never);
    const r = await armar().ctl.leer(sesion(TENANT), CLIENTE);
    expect(leerCliente).toHaveBeenCalledWith(TX, CLIENTE);
    expect(r).toEqual({ id: CLIENTE });
  });

  it("inexistente o ajeno (null) -> 404 no_encontrado", async () => {
    vi.mocked(leerCliente).mockResolvedValue(null);
    await expect(
      armar().ctl.leer(sesion(TENANT), CLIENTE),
    ).rejects.toMatchObject({ codigo: "no_encontrado" });
  });

  it("sin estudio activo rechaza antes de abrir transacción", async () => {
    const { ctl, withTenant } = armar();
    await expect(ctl.leer(sesion(null), CLIENTE)).rejects.toMatchObject({
      codigo: "estudio_requerido",
    });
    expect(withTenant).not.toHaveBeenCalled();
  });
});

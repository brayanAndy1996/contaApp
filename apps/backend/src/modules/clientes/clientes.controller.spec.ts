import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type { SesionResuelta } from "../auth/auth.service.js";
import type { PeticionAcceso } from "../acceso/guards/decoradores.js";
import { ClientesController } from "./clientes.controller.js";

// 007a T9: el controlador solo reparte la petición al servicio (la lectura mínima de 005 pasó al servicio).
const USUARIO = "0190a000-0000-7000-8000-0000000000b1";
const CLIENTE = "0190a000-0000-7000-8000-0000000000c1";
const sesion = { tenantActivo: "t", usuarioId: USUARIO } as SesionResuelta;
const peticion = (alcance: "global" | "asignado" | null) =>
  ({
    acceso:
      alcance === null
        ? undefined
        : { usuarioId: USUARIO, rol: "x", permisos: new Set(), alcance },
  }) as unknown as PeticionAcceso;

function armar() {
  const servicio = {
    crear: vi.fn().mockResolvedValue("creado"),
    listar: vi.fn().mockResolvedValue(["lista"]),
    leer: vi.fn().mockResolvedValue("leido"),
    editar: vi.fn().mockResolvedValue("editado"),
    archivar: vi.fn().mockResolvedValue("archivado"),
    reactivar: vi.fn().mockResolvedValue("reactivado"),
  };
  return { servicio, ctl: new ClientesController(servicio as never) };
}

describe("ClientesController", () => {
  it("POST /clientes pasa el cuerpo crudo al servicio", async () => {
    const { ctl, servicio } = armar();
    expect(await ctl.crear(sesion, { ruc: "x" })).toBe("creado");
    expect(servicio.crear).toHaveBeenCalledWith(sesion, { ruc: "x" });
  });

  it("GET /clientes: alcance global y asignado según el acceso, con la query cruda", async () => {
    const { ctl, servicio } = armar();
    await ctl.listar(sesion, peticion("global"), { q: "a" });
    expect(servicio.listar).toHaveBeenLastCalledWith(sesion, { tipo: "global" }, { q: "a" });
    await ctl.listar(sesion, peticion("asignado"), {});
    expect(servicio.listar).toHaveBeenLastCalledWith(sesion, { tipo: "asignado", usuarioId: USUARIO }, {});
  });

  it("GET /clientes sin acceso en la petición falla cerrado sin llamar al servicio", () => {
    const { ctl, servicio } = armar();
    expect(() => ctl.listar(sesion, peticion(null), {})).toThrowError(
      expect.objectContaining({ codigo: "permiso_denegado" }),
    );
    expect(servicio.listar).not.toHaveBeenCalled();
  });

  it("leer, editar, archivar y reactivar delegan con el clienteId", async () => {
    const { ctl, servicio } = armar();
    expect(await ctl.leer(sesion, CLIENTE)).toBe("leido");
    expect(await ctl.editar(sesion, CLIENTE, { razonSocial: "x" })).toBe("editado");
    expect(await ctl.archivar(sesion, CLIENTE)).toBe("archivado");
    expect(await ctl.reactivar(sesion, CLIENTE)).toBe("reactivado");
    expect(servicio.leer).toHaveBeenCalledWith(sesion, CLIENTE);
    expect(servicio.editar).toHaveBeenCalledWith(sesion, CLIENTE, { razonSocial: "x" });
    expect(servicio.archivar).toHaveBeenCalledWith(sesion, CLIENTE);
    expect(servicio.reactivar).toHaveBeenCalledWith(sesion, CLIENTE);
  });
});

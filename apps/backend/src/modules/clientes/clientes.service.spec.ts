import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  bloquearMiembros: vi.fn(),
  crearCliente: vi.fn(),
  editarCliente: vi.fn(),
  archivarCliente: vi.fn(),
  reactivarCliente: vi.fn(),
  leerClienteDto: vi.fn(),
  listarClientesFiltrado: vi.fn(),
  asignar: vi.fn(),
}));

import {
  archivarCliente,
  asignar,
  bloquearMiembros,
  ClienteArchivadoError,
  crearCliente,
  editarCliente,
  leerClienteDto,
  listarClientesFiltrado,
  reactivarCliente,
  RucDuplicadoError,
} from "@contapp/db";
import type { SesionResuelta } from "../auth/auth.service.js";
import { ClientesService } from "./clientes.service.js";

const TENANT = "0190a000-0000-7000-8000-0000000000a1";
const ACTOR = "0190a000-0000-7000-8000-0000000000b1";
const RESP = "0190a000-0000-7000-8000-0000000000b2";
const CLIENTE = "0190a000-0000-7000-8000-0000000000c1";
const TX = { tx: true };
const sesion = { tenantActivo: TENANT, usuarioId: ACTOR } as SesionResuelta;
const miembro = (rol: string, activo = true) => ({ rol, activo });
const dto = (archivado: boolean) => ({ id: CLIENTE, archivado });

// El orden de las llamadas es el contrato de bloqueo de D4: miembros -> cupo -> cliente -> asignación.
let orden: string[];
const cupo = { libres: vi.fn(), reservar: vi.fn() };

function armar() {
  const withTenant = vi.fn((_ctx: unknown, fn: (tx: unknown) => unknown) => Promise.resolve(fn(TX)));
  return { withTenant, servicio: new ClientesService({ withTenant } as never, cupo as never) };
}

beforeEach(() => {
  orden = [];
  vi.resetAllMocks();
  vi.mocked(bloquearMiembros).mockImplementation(async (_tx, ids) => {
    orden.push("miembros");
    const m = new Map();
    m.set(ACTOR, miembro("dueno"));
    if (ids.includes(RESP)) m.set(RESP, miembro("contador"));
    return m as never;
  });
  cupo.reservar.mockImplementation(async () => void orden.push("cupo"));
  vi.mocked(crearCliente).mockImplementation(async () => (orden.push("cliente"), CLIENTE));
  vi.mocked(reactivarCliente).mockImplementation(async () => void orden.push("cliente"));
  vi.mocked(asignar).mockImplementation(async () => (orden.push("asignacion"), [] as never));
  vi.mocked(leerClienteDto).mockResolvedValue(dto(false) as never);
});

describe("crear", () => {
  it("bloquea miembros, reserva cupo, crea y asigna al responsable, en ese orden", async () => {
    const r = await armar().servicio.crear(sesion, { ruc: "20100070970", responsableId: RESP });
    expect(r).toEqual(dto(false));
    expect(orden).toEqual(["miembros", "cupo", "cliente", "asignacion"]);
    expect(cupo.reservar).toHaveBeenCalledWith(TX, TENANT, 1);
    expect(asignar).toHaveBeenCalledWith(TX, { clienteId: CLIENTE, usuarioId: RESP, tipo: "responsable" });
  });

  it("sin responsable no asigna; con razón social y perfil los pasa al repositorio", async () => {
    const perfil = { regimen: "rg", zona: "general", ventasExoneradas: false, ventasMixtas: false, monedaHabitual: "PEN" };
    await armar().servicio.crear(sesion, { ruc: "20100070970", razonSocial: "Acme", perfil });
    expect(orden).toEqual(["miembros", "cupo", "cliente"]);
    expect(crearCliente).toHaveBeenCalledWith(TX, TENANT, { ruc: "20100070970", razonSocial: "Acme", perfil });
  });

  it("RUC inválido: 400 sin abrir transacción", async () => {
    const { servicio, withTenant } = armar();
    await expect(servicio.crear(sesion, { ruc: "123" })).rejects.toMatchObject({ codigo: "solicitud_invalida" });
    expect(withTenant).not.toHaveBeenCalled();
  });

  it("sin estudio activo: estudio_requerido", async () => {
    await expect(
      armar().servicio.crear({ tenantActivo: null, usuarioId: ACTOR } as SesionResuelta, { ruc: "20100070970" }),
    ).rejects.toMatchObject({ codigo: "estudio_requerido" });
  });

  it.each([
    ["actor ausente", null, "estudio_requerido"],
    ["actor desactivado", miembro("dueno", false), "estudio_requerido"],
    ["actor sin clientes.crear", miembro("lectura"), "permiso_denegado"],
  ])("%s: rechaza sin cupo ni escritura", async (_n, actor, codigo) => {
    vi.mocked(bloquearMiembros).mockResolvedValue(new Map(actor === null ? [] : [[ACTOR, actor]]) as never);
    await expect(armar().servicio.crear(sesion, { ruc: "20100070970" })).rejects.toMatchObject({ codigo });
    expect(cupo.reservar).not.toHaveBeenCalled();
    expect(crearCliente).not.toHaveBeenCalled();
  });

  it("responsable ajeno: 404; desactivado o sin sire.clasificar: 409; en ambos sin cupo ni escritura", async () => {
    const base = new Map([[ACTOR, miembro("dueno")]]);
    vi.mocked(bloquearMiembros).mockResolvedValue(base as never);
    await expect(armar().servicio.crear(sesion, { ruc: "20100070970", responsableId: RESP })).rejects.toMatchObject({
      codigo: "no_encontrado",
    });
    for (const m of [miembro("contador", false), miembro("lectura")]) {
      vi.mocked(bloquearMiembros).mockResolvedValue(new Map([...base, [RESP, m]]) as never);
      await expect(armar().servicio.crear(sesion, { ruc: "20100070970", responsableId: RESP })).rejects.toMatchObject({
        codigo: "miembro_no_asignable",
      });
    }
    expect(cupo.reservar).not.toHaveBeenCalled();
    expect(crearCliente).not.toHaveBeenCalled();
  });

  it("RUC repetido -> 409 ruc_duplicado; el error de cupo se propaga tal cual", async () => {
    vi.mocked(crearCliente).mockRejectedValue(new RucDuplicadoError());
    await expect(armar().servicio.crear(sesion, { ruc: "20100070970" })).rejects.toMatchObject({ codigo: "ruc_duplicado" });
    const sinCupo = new Error("cupo");
    cupo.reservar.mockRejectedValue(sinCupo);
    await expect(armar().servicio.crear(sesion, { ruc: "20100070970" })).rejects.toBe(sinCupo);
  });
});

describe("editar", () => {
  it("devuelve el DTO; 404 si no existe; 409 si está archivado", async () => {
    vi.mocked(editarCliente).mockResolvedValue(true);
    expect(await armar().servicio.editar(sesion, CLIENTE, { razonSocial: "Nueva" })).toEqual(dto(false));
    expect(editarCliente).toHaveBeenCalledWith(TX, CLIENTE, { razonSocial: "Nueva" });
    vi.mocked(editarCliente).mockResolvedValue(false);
    await expect(armar().servicio.editar(sesion, CLIENTE, {})).rejects.toMatchObject({ codigo: "no_encontrado" });
    vi.mocked(editarCliente).mockRejectedValue(new ClienteArchivadoError());
    await expect(armar().servicio.editar(sesion, CLIENTE, {})).rejects.toMatchObject({ codigo: "cliente_archivado" });
  });

  it("razón social solo con espacios o catálogo inválido: 400 sin transacción", async () => {
    const { servicio, withTenant } = armar();
    for (const cuerpo of [{ razonSocial: "   " }, { perfil: { regimen: "x" } }]) {
      await expect(servicio.editar(sesion, CLIENTE, cuerpo)).rejects.toMatchObject({ codigo: "solicitud_invalida" });
    }
    expect(withTenant).not.toHaveBeenCalled();
  });
});

describe("archivar y reactivar", () => {
  it("archivar no bloquea miembros ni cupo; 404 si no existe", async () => {
    vi.mocked(leerClienteDto).mockResolvedValue(dto(true) as never);
    expect(await armar().servicio.archivar(sesion, CLIENTE)).toEqual(dto(true));
    expect(archivarCliente).toHaveBeenCalledWith(TX, CLIENTE);
    expect(bloquearMiembros).not.toHaveBeenCalled();
    expect(cupo.reservar).not.toHaveBeenCalled();
    vi.mocked(leerClienteDto).mockResolvedValue(null);
    await expect(armar().servicio.archivar(sesion, CLIENTE)).rejects.toMatchObject({ codigo: "no_encontrado" });
  });

  it("reactivar un archivado: miembros -> cupo -> cliente", async () => {
    vi.mocked(leerClienteDto).mockResolvedValueOnce(dto(true) as never).mockResolvedValue(dto(false) as never);
    expect(await armar().servicio.reactivar(sesion, CLIENTE)).toEqual(dto(false));
    expect(orden).toEqual(["miembros", "cupo", "cliente"]);
  });

  it("reactivar uno ya activo es idempotente y no consume cupo; inexistente da 404", async () => {
    expect(await armar().servicio.reactivar(sesion, CLIENTE)).toEqual(dto(false));
    expect(cupo.reservar).not.toHaveBeenCalled();
    expect(reactivarCliente).not.toHaveBeenCalled();
    vi.mocked(leerClienteDto).mockResolvedValue(null);
    await expect(armar().servicio.reactivar(sesion, CLIENTE)).rejects.toMatchObject({ codigo: "no_encontrado" });
  });

  it("reactivar con actor sin clientes.archivar o con cupo lleno no escribe", async () => {
    vi.mocked(bloquearMiembros).mockResolvedValue(new Map([[ACTOR, miembro("contador")]]) as never);
    await expect(armar().servicio.reactivar(sesion, CLIENTE)).rejects.toMatchObject({ codigo: "permiso_denegado" });
    vi.mocked(bloquearMiembros).mockResolvedValue(new Map([[ACTOR, miembro("dueno")]]) as never);
    vi.mocked(leerClienteDto).mockResolvedValue(dto(true) as never);
    cupo.reservar.mockRejectedValue(new Error("cupo"));
    await expect(armar().servicio.reactivar(sesion, CLIENTE)).rejects.toThrow("cupo");
    expect(reactivarCliente).not.toHaveBeenCalled();
  });
});

describe("listar y leer", () => {
  it("listar pasa solo los filtros presentes y descarta claves desconocidas", async () => {
    vi.mocked(listarClientesFiltrado).mockResolvedValue([] as never);
    const alcance = { tipo: "global" } as const;
    await armar().servicio.listar(sesion, alcance, { q: "ab", archivados: "1", credencial: "invalida", responsable: "ninguno", x: 1 });
    expect(listarClientesFiltrado).toHaveBeenLastCalledWith(TX, alcance, {
      responsable: "ninguno",
      credencial: "invalida",
      archivados: true,
      q: "ab",
    });
    await armar().servicio.listar(sesion, alcance, {});
    expect(listarClientesFiltrado).toHaveBeenLastCalledWith(TX, alcance, {});
  });

  it("listar: filtros inválidos o NUL en q dan 400 sin transacción", async () => {
    const { servicio, withTenant } = armar();
    for (const q of [{ credencial: "x" }, { q: "a\u0000b" }, { q: "x".repeat(101) }]) {
      expect(() => servicio.listar(sesion, { tipo: "global" }, q)).toThrowError(
        expect.objectContaining({ codigo: "solicitud_invalida" }),
      );
    }
    expect(withTenant).not.toHaveBeenCalled();
  });

  it("leer devuelve el DTO o 404", async () => {
    expect(await armar().servicio.leer(sesion, CLIENTE)).toEqual(dto(false));
    vi.mocked(leerClienteDto).mockResolvedValue(null);
    await expect(armar().servicio.leer(sesion, CLIENTE)).rejects.toMatchObject({ codigo: "no_encontrado" });
  });
});

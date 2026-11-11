// Spec 017 (T14a, P-2, D-12, CA-12 a CA-14): `AuditoriaService` sin BD. Paginación exacta, cursor, filas que no cumplen el
// contrato, autor o cliente que no se resuelven, y una consulta inválida que no llega a abrir la BD.
import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  listarAuditoria: vi.fn(),
  resolverAutores: vi.fn(),
  leerClientesPorIds: vi.fn(),
  resolverUsuariosDeEntidades: vi.fn(),
}));

import {
  leerClientesPorIds,
  listarAuditoria,
  MAX_PAGINA_AUDITORIA,
  resolverAutores,
  resolverUsuariosDeEntidades,
  type FilaAuditoria,
} from "@contapp/db";
import { AccesoError } from "../acceso/errores.js";
import { AuditoriaService } from "./auditoria.service.js";
import { codificarCursor } from "../notificaciones/cursor.js";

const TENANT = "0190a000-0000-7000-8000-0000000000a1";
const USUARIO = "0190a000-0000-7000-8000-0000000000b1";
const CLIENTE = "0190a000-0000-7000-8000-0000000000c1";
const SESION = { tenantActivo: TENANT, usuarioId: USUARIO } as never;
const tx = { tx: 1 } as never;
const withTenant = vi.fn((_ctx: unknown, f: (t: unknown) => Promise<unknown>) => f(tx));
const db = { withTenant } as never;

function fila(n: number, extra: Partial<FilaAuditoria> = {}): FilaAuditoria {
  return {
    id: `0190a000-0000-7000-8000-${String(n).padStart(12, "0")}`,
    ocurridaEn: new Date(Date.UTC(2026, 9, 5, 12, 0, 60 - (n % 60), 123)),
    accion: "cliente.creado",
    actorTipo: "usuario",
    usuarioId: USUARIO,
    trabajoId: null,
    clienteId: CLIENTE,
    entidad: "cliente",
    entidadId: CLIENTE,
    datos: { campo: "razonSocial" },
    ...extra,
  };
}

function servicio() {
  return new AuditoriaService(db);
}

describe("AuditoriaService.listar", () => {
  beforeEach(() => {
    withTenant.mockClear();
    vi.mocked(listarAuditoria).mockReset();
    vi.mocked(resolverAutores).mockReset();
    vi.mocked(leerClientesPorIds).mockReset();
    vi.mocked(resolverUsuariosDeEntidades).mockReset();
    vi.mocked(resolverUsuariosDeEntidades).mockResolvedValue({ membresias: new Map(), invitaciones: new Map() });
    vi.mocked(resolverAutores).mockResolvedValue(new Map([[USUARIO, { id: USUARIO, nombre: "Ana", activo: true }]]));
    vi.mocked(leerClientesPorIds).mockResolvedValue(new Map([[CLIENTE, { id: CLIENTE, ruc: "20123456789", razonSocial: "Acme SAC" }]]));
  });

  it("una página con filas devuelve el DTO sin tenantId ni usuarioId crudo y sin cursor", async () => {
    vi.mocked(listarAuditoria).mockResolvedValue([fila(1)]);
    const r = await servicio().listar(SESION, undefined);
    expect(r.siguiente).toBeNull();
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toEqual({
      id: fila(1).id,
      ocurridaEn: fila(1).ocurridaEn.toISOString(),
      accion: "cliente.creado",
      actor: { tipo: "usuario", autor: { id: USUARIO, nombre: "Ana", activo: true }, trabajoId: null },
      cliente: { id: CLIENTE, ruc: "20123456789", razonSocial: "Acme SAC" },
      entidad: "cliente",
      entidadId: CLIENTE,
      datos: { campo: "razonSocial" },
      objetivo: null,
    });
    expect(JSON.stringify(r)).not.toContain("usuarioId");
    expect(withTenant).toHaveBeenCalledWith({ tenantId: TENANT, userId: USUARIO }, expect.any(Function));
    expect(vi.mocked(listarAuditoria).mock.calls[0]![1]).toEqual({ limite: MAX_PAGINA_AUDITORIA });
  });

  it("resuelve autores y clientes de una vez, solo con ids no nulos", async () => {
    vi.mocked(listarAuditoria).mockResolvedValue([
      fila(1),
      fila(2, { usuarioId: null, clienteId: null, actorTipo: "sistema", entidadId: null }),
    ]);
    await servicio().listar(SESION, undefined);
    expect(resolverAutores).toHaveBeenCalledTimes(1);
    expect(resolverAutores).toHaveBeenCalledWith(tx, [USUARIO]);
    expect(leerClientesPorIds).toHaveBeenCalledTimes(1);
    expect(leerClientesPorIds).toHaveBeenCalledWith(tx, [CLIENTE]);
  });

  it("una página llena con una fila más da cursor de la última fila entregada", async () => {
    const llena = Array.from({ length: MAX_PAGINA_AUDITORIA }, (_, i) => fila(i + 1));
    vi.mocked(listarAuditoria).mockResolvedValueOnce(llena).mockResolvedValueOnce([fila(99)]);
    const r = await servicio().listar(SESION, undefined);
    expect(r.items).toHaveLength(MAX_PAGINA_AUDITORIA);
    const ultima = llena[llena.length - 1]!;
    expect(r.siguiente).toBe(codificarCursor({ en: ultima.ocurridaEn, id: ultima.id }));
    expect(vi.mocked(listarAuditoria).mock.calls[1]![1]).toEqual({ antes: { en: ultima.ocurridaEn, id: ultima.id }, limite: 1 });
  });

  it("una página llena sin ninguna fila más no inventa una página vacía (cursor null)", async () => {
    const llena = Array.from({ length: MAX_PAGINA_AUDITORIA }, (_, i) => fila(i + 1));
    vi.mocked(listarAuditoria).mockResolvedValueOnce(llena).mockResolvedValueOnce([]);
    const r = await servicio().listar(SESION, undefined);
    expect(r.items).toHaveLength(MAX_PAGINA_AUDITORIA);
    expect(r.siguiente).toBeNull();
    expect(listarAuditoria).toHaveBeenCalledTimes(2);
  });

  it("una página incompleta no consulta más filas", async () => {
    vi.mocked(listarAuditoria).mockResolvedValue([fila(1), fila(2)]);
    const r = await servicio().listar(SESION, undefined);
    expect(r.siguiente).toBeNull();
    expect(listarAuditoria).toHaveBeenCalledTimes(1);
  });

  it("una página vacía devuelve items vacíos sin cursor", async () => {
    vi.mocked(listarAuditoria).mockResolvedValue([]);
    expect(await servicio().listar(SESION, {})).toEqual({ items: [], siguiente: null });
  });

  it("con cursor pasa la posición como `antes`", async () => {
    vi.mocked(listarAuditoria).mockResolvedValue([]);
    const en = new Date("2026-10-05T12:00:00.123Z");
    const id = "0190a000-0000-7000-8000-0000000000d1";
    await servicio().listar(SESION, { cursor: codificarCursor({ en, id }) });
    expect(vi.mocked(listarAuditoria).mock.calls[0]![1]).toEqual({ antes: { en, id }, limite: MAX_PAGINA_AUDITORIA });
  });

  it("un autor que no se resolvió sale como autor null, no como el id crudo", async () => {
    vi.mocked(resolverAutores).mockResolvedValue(new Map());
    vi.mocked(listarAuditoria).mockResolvedValue([fila(1)]);
    const r = await servicio().listar(SESION, undefined);
    expect(r.items[0]!.actor).toEqual({ tipo: "usuario", autor: null, trabajoId: null });
    expect(JSON.stringify(r)).not.toContain(USUARIO);
  });

  it("un cliente que ya no se lee (borrado o fuera de alcance) sale como cliente null", async () => {
    vi.mocked(leerClientesPorIds).mockResolvedValue(new Map());
    vi.mocked(listarAuditoria).mockResolvedValue([fila(1)]);
    const r = await servicio().listar(SESION, undefined);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.cliente).toBeNull();
    expect(r.items[0]!.entidadId).toBe(CLIENTE);
  });

  it("una fila que no cumple el contrato (acción fuera del catálogo) no sale; las demás sí", async () => {
    vi.mocked(listarAuditoria).mockResolvedValue([
      fila(1, { accion: "accion.inventada" }),
      fila(2),
      fila(3, { entidadId: "no-es-uuid" }),
    ]);
    const r = await servicio().listar(SESION, undefined);
    expect(r.items.map((i) => i.id)).toEqual([fila(2).id]);
  });

  // Spec 017 · T18a-servidor (P-4): `objetivo` = el usuario afectado, resuelto por lote (un solo resolverAutores por página).
  describe("objetivo", () => {
    const OBJ = "0190a000-0000-7000-8000-0000000000e1";
    const MEMBRESIA = "0190a000-0000-7000-8000-0000000000e2";
    const INVITACION = "0190a000-0000-7000-8000-0000000000e3";
    const baja = { id: OBJ, nombre: "Beto", activo: false };
    const sujeto = (accion: string, extra: Partial<FilaAuditoria> = {}) =>
      fila(10, { accion, clienteId: null, entidad: "membresia", entidadId: MEMBRESIA, datos: {}, ...extra });

    beforeEach(() => {
      vi.mocked(resolverAutores).mockResolvedValue(
        new Map([
          [USUARIO, { id: USUARIO, nombre: "Ana", activo: true }],
          [OBJ, baja],
        ]),
      );
      vi.mocked(resolverUsuariosDeEntidades).mockResolvedValue({
        membresias: new Map([[MEMBRESIA, OBJ]]),
        invitaciones: new Map([[INVITACION, OBJ]]),
      });
    });

    it.each(["miembro.alta", "miembro.rol_cambiado", "miembro.desactivado", "miembro.reactivado", "miembro.eliminado"])(
      "%s: el usuario de la membresía, con la forma del autor",
      async (accion) => {
        vi.mocked(listarAuditoria).mockResolvedValue([sujeto(accion)]);
        const r = await servicio().listar(SESION, undefined);
        expect(r.items[0]!.objetivo).toEqual(baja);
        expect(resolverUsuariosDeEntidades).toHaveBeenCalledWith(tx, { membresias: [MEMBRESIA], invitaciones: [] });
      },
    );

    it.each(["asignacion.agregada", "asignacion.quitada", "asignacion.tipo_cambiado"])("%s: el usuarioId de los datos", async (accion) => {
      vi.mocked(listarAuditoria).mockResolvedValue([sujeto(accion, { entidad: "asignacion", clienteId: CLIENTE, datos: { usuarioId: OBJ, tipo: "responsable" } })]);
      const r = await servicio().listar(SESION, undefined);
      expect(r.items[0]!.objetivo).toEqual(baja);
    });

    it.each(["invitacion.creada", "invitacion.revocada", "invitacion.modificada"])("%s: quien aceptó la invitación", async (accion) => {
      vi.mocked(listarAuditoria).mockResolvedValue([sujeto(accion, { entidad: "invitacion", entidadId: INVITACION })]);
      const r = await servicio().listar(SESION, undefined);
      expect(r.items[0]!.objetivo).toEqual(baja);
      expect(resolverUsuariosDeEntidades).toHaveBeenCalledWith(tx, { membresias: [], invitaciones: [INVITACION] });
    });

    it("una invitación sin aceptar, una membresía eliminada o un usuarioId inválido dan objetivo null", async () => {
      vi.mocked(resolverUsuariosDeEntidades).mockResolvedValue({ membresias: new Map(), invitaciones: new Map() });
      vi.mocked(listarAuditoria).mockResolvedValue([
        sujeto("invitacion.creada", { entidad: "invitacion", entidadId: INVITACION }),
        sujeto("miembro.eliminado"),
        sujeto("asignacion.quitada", { entidad: "asignacion", datos: { usuarioId: "no-es-uuid" } }),
        sujeto("asignacion.agregada", { entidad: "asignacion", datos: {} }),
      ]);
      const r = await servicio().listar(SESION, undefined);
      expect(r.items.map((i) => i.objetivo)).toEqual([null, null, null, null]);
    });

    it("un usuario que ya no se resuelve como autor da objetivo null, no el id crudo", async () => {
      vi.mocked(resolverAutores).mockResolvedValue(new Map());
      vi.mocked(listarAuditoria).mockResolvedValue([sujeto("miembro.alta")]);
      const r = await servicio().listar(SESION, undefined);
      expect(r.items[0]!.objetivo).toBeNull();
      expect(JSON.stringify(r)).not.toContain(OBJ);
    });

    it("las demás acciones tienen objetivo null y no consultan membresías ni invitaciones", async () => {
      vi.mocked(listarAuditoria).mockResolvedValue([fila(1), fila(2, { accion: "cliente.editado", datos: { cambios: { zona: ["A", "B"] } } })]);
      const r = await servicio().listar(SESION, undefined);
      expect(r.items.map((i) => i.objetivo)).toEqual([null, null]);
      expect(resolverUsuariosDeEntidades).not.toHaveBeenCalled();
      expect(r.items[1]!.datos).toEqual({ cambios: { zona: ["A", "B"] } });
    });

    it("resuelve los autores del actor y los objetivos en UNA consulta, sin repetir ids", async () => {
      vi.mocked(listarAuditoria).mockResolvedValue([sujeto("miembro.alta"), sujeto("miembro.reactivado"), fila(1)]);
      await servicio().listar(SESION, undefined);
      expect(resolverAutores).toHaveBeenCalledTimes(1);
      const ids = vi.mocked(resolverAutores).mock.calls[0]![1];
      expect([...new Set(ids)].sort()).toEqual([OBJ, USUARIO].sort());
    });
  });

  it.each([
    ["una clave ajena", { usuarioId: USUARIO }],
    ["un límite", { limite: "500" }],
    ["un cursor mal formado", { cursor: "no-es-un-cursor" }],
    ["un cursor que no es texto", { cursor: 3 }],
    ["una consulta que no es objeto", "x"],
  ])("rechaza con 400 %s sin abrir la BD", async (_n, query) => {
    const e = await servicio().listar(SESION, query).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AccesoError);
    expect((e as AccesoError).codigo).toBe("solicitud_invalida");
    expect(withTenant).not.toHaveBeenCalled();
  });

  it("sin estudio activo es estudio_requerido", async () => {
    const e = await servicio()
      .listar({ tenantActivo: null, usuarioId: USUARIO } as never, undefined)
      .catch((x: unknown) => x);
    expect((e as AccesoError).codigo).toBe("estudio_requerido");
    expect(withTenant).not.toHaveBeenCalled();
  });
});

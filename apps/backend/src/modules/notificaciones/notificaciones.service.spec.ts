// Spec 017 (T14a, D-10, D-11; CA-11, CA-12): `NotificacionesService` sin BD. Filas que no cumplen el contrato, cliente sin razón
// social, cuerpos y consultas inválidos, ids mal formados y un usuario que ya no es miembro activo.
import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  contarNoLeidas: vi.fn(),
  listarNotificaciones: vi.fn(),
  marcarLeida: vi.fn(),
  marcarLeidasHasta: vi.fn(),
}));
vi.mock("../trabajos/trabajos.service.js", async (original) => ({
  ...(await original<typeof import("../trabajos/trabajos.service.js")>()),
  actorDe: vi.fn(),
}));

import {
  contarNoLeidas,
  listarNotificaciones,
  marcarLeida,
  marcarLeidasHasta,
  MAX_PAGINA_NOTIFICACIONES,
  TOPE_NO_LEIDAS,
  type FilaNotificacion,
} from "@contapp/db";
import { AccesoError } from "../acceso/errores.js";
import { actorDe } from "../trabajos/trabajos.service.js";
import { codificarCursor } from "./cursor.js";
import { NotificacionesService } from "./notificaciones.service.js";

const TENANT = "0190a000-0000-7000-8000-0000000000a1";
const USUARIO = "0190a000-0000-7000-8000-0000000000b1";
const CLIENTE = "0190a000-0000-7000-8000-0000000000c1";
const ALCANCE = { tipo: "asignado", usuarioId: USUARIO };
const SESION = { tenantActivo: TENANT, usuarioId: USUARIO } as never;
const tx = { tx: 1 } as never;
const withTenant = vi.fn((_ctx: unknown, f: (t: unknown) => Promise<unknown>) => f(tx));
const servicio = () => new NotificacionesService({ withTenant } as never);

function fila(n: number, extra: Partial<FilaNotificacion> = {}): FilaNotificacion {
  return {
    id: `0190a000-0000-7000-8000-${String(n).padStart(12, "0")}`,
    tipo: "credencial_invalida",
    creadaEn: new Date(Date.UTC(2026, 9, 5, 12, 0, 59 - (n % 59), 0)),
    leidaEn: null,
    clienteId: CLIENTE,
    trabajoId: null,
    razonSocial: "Acme SAC",
    params: { credencial: "sol" },
    ...extra,
  };
}

async function codigoDe(p: Promise<unknown>): Promise<string | undefined> {
  const e = await p.catch((x: unknown) => x);
  return e instanceof AccesoError ? e.codigo : undefined;
}

describe("NotificacionesService", () => {
  beforeEach(() => {
    withTenant.mockClear();
    vi.mocked(contarNoLeidas).mockReset();
    vi.mocked(listarNotificaciones).mockReset();
    vi.mocked(marcarLeida).mockReset();
    vi.mocked(marcarLeidasHasta).mockReset();
    vi.mocked(actorDe).mockReset();
    vi.mocked(actorDe).mockResolvedValue({ usuarioId: USUARIO, rol: "contador", alcance: ALCANCE } as never);
  });

  describe("listar", () => {
    it("devuelve el DTO sin tenantId, usuarioId ni claveDedupe y pasa el alcance releído", async () => {
      vi.mocked(listarNotificaciones).mockResolvedValue([fila(1, { leidaEn: new Date("2026-10-05T12:01:00.000Z") })]);
      const r = await servicio().listar(SESION, undefined);
      expect(r.siguiente).toBeNull();
      expect(r.items[0]).toEqual({
        id: fila(1).id,
        tipo: "credencial_invalida",
        creadaEn: fila(1).creadaEn.toISOString(),
        leidaEn: "2026-10-05T12:01:00.000Z",
        cliente: { id: CLIENTE, razonSocial: "Acme SAC" },
        trabajoId: null,
        params: { credencial: "sol" },
      });
      expect(vi.mocked(listarNotificaciones).mock.calls[0]![1]).toBe(ALCANCE);
      expect(withTenant).toHaveBeenCalledWith({ tenantId: TENANT, userId: USUARIO }, expect.any(Function));
    });

    it("una notificación sin cliente sale con cliente null; con cliente sin razón social, texto vacío", async () => {
      vi.mocked(listarNotificaciones).mockResolvedValue([
        fila(1, { clienteId: null, razonSocial: null }),
        fila(2, { razonSocial: null }),
      ]);
      const r = await servicio().listar(SESION, {});
      expect(r.items[0]!.cliente).toBeNull();
      expect(r.items[1]!.cliente).toEqual({ id: CLIENTE, razonSocial: "" });
    });

    it("una fila con tipo reservado o params fuera de contrato no sale; las demás sí", async () => {
      vi.mocked(listarNotificaciones).mockResolvedValue([
        fila(1, { tipo: "tipo_reservado" as never }),
        fila(2),
        fila(3, { params: { credencial: "sol", extra: "x" } }),
        fila(4, { params: { credencial: "otra" } }),
      ]);
      const r = await servicio().listar(SESION, undefined);
      expect(r.items.map((i) => i.id)).toEqual([fila(2).id]);
    });

    it("una página llena con una fila más da cursor; sin fila más, null", async () => {
      const llena = Array.from({ length: MAX_PAGINA_NOTIFICACIONES }, (_, i) => fila(i + 1));
      const ultima = llena[llena.length - 1]!;
      vi.mocked(listarNotificaciones).mockResolvedValueOnce(llena).mockResolvedValueOnce([fila(99)]);
      const con = await servicio().listar(SESION, undefined);
      expect(con.siguiente).toBe(codificarCursor({ en: ultima.creadaEn, id: ultima.id }));
      expect(vi.mocked(listarNotificaciones).mock.calls[1]![2]).toEqual({ antes: { en: ultima.creadaEn, id: ultima.id }, limite: 1 });

      vi.mocked(listarNotificaciones).mockReset();
      vi.mocked(listarNotificaciones).mockResolvedValueOnce(llena).mockResolvedValueOnce([]);
      const sin = await servicio().listar(SESION, undefined);
      expect(sin.items).toHaveLength(MAX_PAGINA_NOTIFICACIONES);
      expect(sin.siguiente).toBeNull();
    });

    it("con cursor pasa la posición como `antes`", async () => {
      vi.mocked(listarNotificaciones).mockResolvedValue([]);
      const en = new Date("2026-10-05T12:00:00.123Z");
      const id = "0190a000-0000-7000-8000-0000000000d1";
      await servicio().listar(SESION, { cursor: codificarCursor({ en, id }) });
      expect(vi.mocked(listarNotificaciones).mock.calls[0]![2]).toEqual({ antes: { en, id }, limite: MAX_PAGINA_NOTIFICACIONES });
    });

    it("una consulta con claves ajenas o cursor mal formado es 400 sin abrir la BD", async () => {
      expect(await codigoDe(servicio().listar(SESION, { usuarioId: USUARIO }))).toBe("solicitud_invalida");
      expect(await codigoDe(servicio().listar(SESION, { cursor: "xx" }))).toBe("solicitud_invalida");
      expect(withTenant).not.toHaveBeenCalled();
    });

    it("quien ya no es miembro activo recibe estudio_requerido y no se lee nada", async () => {
      vi.mocked(actorDe).mockResolvedValue(null);
      expect(await codigoDe(servicio().listar(SESION, undefined))).toBe("estudio_requerido");
      expect(listarNotificaciones).not.toHaveBeenCalled();
    });
  });

  describe("noLeidas", () => {
    it("cuenta con el alcance releído y el tope", async () => {
      vi.mocked(contarNoLeidas).mockResolvedValue(7);
      expect(await servicio().noLeidas(SESION, undefined)).toEqual({ noLeidas: 7 });
      expect(await servicio().noLeidas(SESION, null)).toEqual({ noLeidas: 7 });
      expect(await servicio().noLeidas(SESION, {})).toEqual({ noLeidas: 7 });
      expect(contarNoLeidas).toHaveBeenCalledWith(tx, ALCANCE, TOPE_NO_LEIDAS);
    });

    it("cualquier parámetro es 400", async () => {
      expect(await codigoDe(servicio().noLeidas(SESION, { usuarioId: USUARIO }))).toBe("solicitud_invalida");
      expect(await codigoDe(servicio().noLeidas(SESION, "x"))).toBe("solicitud_invalida");
      expect(await codigoDe(servicio().noLeidas(SESION, 5))).toBe("solicitud_invalida");
      expect(contarNoLeidas).not.toHaveBeenCalled();
    });

    it("quien ya no es miembro activo recibe estudio_requerido", async () => {
      vi.mocked(actorDe).mockResolvedValue(null);
      expect(await codigoDe(servicio().noLeidas(SESION, undefined))).toBe("estudio_requerido");
      expect(contarNoLeidas).not.toHaveBeenCalled();
    });
  });

  describe("marcarHasta", () => {
    it("marca hasta el instante y devuelve cuántas", async () => {
      vi.mocked(marcarLeidasHasta).mockResolvedValue(3);
      expect(await servicio().marcarHasta(SESION, { hasta: "2026-10-05T12:00:00.123Z" })).toEqual({ marcadas: 3 });
      expect(marcarLeidasHasta).toHaveBeenCalledWith(tx, ALCANCE, new Date("2026-10-05T12:00:00.123Z"));
    });

    it.each([
      ["sin cuerpo", undefined],
      ["con una clave ajena", { hasta: "2026-10-05T12:00:00.123Z", usuarioId: USUARIO }],
      ["con una fecha mal formada", { hasta: "ayer" }],
      ["sin `hasta`", {}],
    ])("rechaza con 400 un cuerpo %s", async (_n, cuerpo) => {
      expect(await codigoDe(servicio().marcarHasta(SESION, cuerpo))).toBe("solicitud_invalida");
      expect(marcarLeidasHasta).not.toHaveBeenCalled();
      expect(withTenant).not.toHaveBeenCalled();
    });
  });

  describe("marcar", () => {
    const ID = "0190a000-0000-7000-8000-0000000000e1";

    it("marca la propia, con el id en minúsculas y el alcance releído", async () => {
      vi.mocked(marcarLeida).mockResolvedValue(true);
      await expect(servicio().marcar(SESION, ID.toUpperCase(), undefined)).resolves.toBeUndefined();
      expect(marcarLeida).toHaveBeenCalledWith(tx, ID, ALCANCE);
      await expect(servicio().marcar(SESION, ID, null)).resolves.toBeUndefined();
      await expect(servicio().marcar(SESION, ID, {})).resolves.toBeUndefined();
    });

    it.each([
      ["un texto", "x"],
      ["un número", 5],
      ["un arreglo", []],
      ["un objeto con claves", { usuarioId: USUARIO }],
    ])("un cuerpo que es %s es 400", async (_n, cuerpo) => {
      expect(await codigoDe(servicio().marcar(SESION, ID, cuerpo))).toBe("solicitud_invalida");
      expect(marcarLeida).not.toHaveBeenCalled();
    });

    it("un id mal formado es 404, igual que uno ajeno o inexistente, y no toca la BD", async () => {
      expect(await codigoDe(servicio().marcar(SESION, "no-es-uuid", undefined))).toBe("no_encontrado");
      expect(withTenant).not.toHaveBeenCalled();
      vi.mocked(marcarLeida).mockResolvedValue(false);
      expect(await codigoDe(servicio().marcar(SESION, ID, undefined))).toBe("no_encontrado");
    });

    it("quien ya no es miembro activo recibe estudio_requerido", async () => {
      vi.mocked(actorDe).mockResolvedValue(null);
      expect(await codigoDe(servicio().marcar(SESION, ID, undefined))).toBe("estudio_requerido");
      expect(marcarLeida).not.toHaveBeenCalled();
    });
  });
});

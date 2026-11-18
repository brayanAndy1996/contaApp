// Spec 023, T15 (cobertura): ramas de `sol.buzon.revisar` que la integración no recorre. BD y portal son dobles:
// parámetros inválidos, código de tipo recortado o descartado, inserción que ya hizo otra captura, aviso en vivo que falla
// y fallo al guardar el cursor pendiente durante un error del portal.
import { ErrorDatos, ErrorTransitorio } from "@contapp/sunat";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  estado: null as unknown,
  insertar: vi.fn<(tx: unknown, m: unknown) => Promise<unknown>>(async () => ({
    id: "m-1",
  })),
  guardarEstado: vi.fn<(tx: unknown, c: string, e: unknown) => Promise<void>>(
    async () => undefined,
  ),
  destinatarios: vi.fn(async (): Promise<string[]> => []),
}));
vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  estadoCredenciales: vi.fn(async () => [{ id: "cred-1", tipo: "sol" }]),
  leerEstadoBuzon: vi.fn(async () => h.estado),
  // T21 (H-023-2-4, H-023-2-1): reloj de la BD y marca de relleno, también dobles.
  relojBdBuzon: vi.fn(async () => new Date()),
  marcarRellenoBuzon: vi.fn(async () => undefined),
  conocidosBuzon: vi.fn(async () => new Map<string, boolean>()),
  actualizarConocidosBuzon: vi.fn(async () => 0),
  insertarMensajeBuzon: h.insertar,
  guardarEstadoCapturaBuzon: h.guardarEstado,
  destinatariosNuevos: h.destinatarios,
}));

import { revisarBuzon } from "./revisar-buzon.js";

const trabajo = (parametros: unknown) => ({
  id: "j-1",
  tenantId: "0190a000-0000-7000-8000-0000000000e1",
  clienteId: "0190a000-0000-7000-8000-0000000000c1",
  ruc: "20700000002",
  tipo: "sol.buzon.revisar",
  parametros,
  intentos: 0,
  creadoPor: null,
});
const ctx = (parametros: unknown) => ({
  trabajo: trabajo(parametros),
  conToken: async <T>(f: (t: string) => Promise<T>) => f("tok"),
});

const msg = (idSunat: string, o: Record<string, unknown> = {}) => ({
  idSunat,
  asunto: "Aviso general",
  remitente: "SUNAT",
  fecha: new Date().toISOString(),
  codigoTipo: null,
  leidoEnSunat: false,
  adjuntos: [],
  ...o,
});

function armar(
  paginas: (unknown | Error)[],
  notificador?: { avisar: ReturnType<typeof vi.fn> },
) {
  const secreto = {
    usar: <T>(f: (v: unknown) => T): T => f({ usuario: "u", clave: "c" }),
    destruir: vi.fn(),
  };
  let n = 0;
  const solPortal = {
    listarMensajes: vi.fn(async () => {
      const p = paginas[Math.min(n++, paginas.length - 1)];
      if (p instanceof Error) throw p;
      return p;
    }),
    obtenerMensaje: vi.fn(),
  };
  const proc = revisarBuzon({
    db: {
      withTenant: async (_c: unknown, f: (tx: unknown) => unknown) => f({}),
    } as never,
    servicio: { descifrarCredencial: vi.fn(async () => secreto) } as never,
    solPortal: solPortal as never,
    ...(notificador === undefined ? {} : { notificador: notificador as never }),
  });
  return { proc, solPortal };
}

beforeEach(() => {
  h.estado = null;
  h.insertar.mockReset();
  h.insertar.mockResolvedValue({ id: "m-1" });
  h.guardarEstado.mockReset();
  h.guardarEstado.mockResolvedValue(undefined);
  h.destinatarios.mockReset();
  h.destinatarios.mockResolvedValue([]);
});

describe("parámetros", () => {
  it.each([undefined, null, { x: 1 }, "texto"])(
    "parámetros inválidos (%j): ErrorDatos sin llamar al portal",
    async (parametros) => {
      const { proc, solPortal } = armar([{ mensajes: [], siguiente: null }]);
      await expect(proc(ctx(parametros) as never)).rejects.toBeInstanceOf(
        ErrorDatos,
      );
      expect(solPortal.listarMensajes).not.toHaveBeenCalled();
    },
  );
});

describe("código de tipo guardado", () => {
  it("se recorta; vacío, solo espacios o de más de 32 caracteres se guardan como null", async () => {
    const { proc } = armar([
      {
        mensajes: [
          msg("m1", { codigoTipo: "  REC  " }),
          msg("m2", { codigoTipo: "" }),
          msg("m3", { codigoTipo: "   " }),
          msg("m4", { codigoTipo: "X".repeat(33) }),
          msg("m5", { codigoTipo: "Y".repeat(32) }),
          msg("m6", { codigoTipo: null }),
        ],
        siguiente: null,
      },
    ]);
    await proc(ctx({}) as never);
    const guardados = new Map(
      h.insertar.mock.calls.map((c) => {
        const m = c[1] as { idSunat: string; codigoTipo: string | null };
        return [m.idSunat, m.codigoTipo];
      }),
    );
    expect(guardados).toEqual(
      new Map([
        ["m1", "REC"],
        ["m2", null],
        ["m3", null],
        ["m4", null],
        ["m5", "Y".repeat(32)],
        ["m6", null],
      ]),
    );
  });
});

describe("inserción repetida y aviso en vivo", () => {
  it("si otra captura ya insertó el mensaje, no cuenta, no avisa y no lee destinatarios", async () => {
    h.insertar.mockResolvedValue(null);
    const notificador = { avisar: vi.fn(async () => undefined) };
    const { proc } = armar(
      [{ mensajes: [msg("m1", { codigoTipo: "REC" })], siguiente: null }],
      notificador,
    );
    const r = (await proc(ctx({}) as never)) as Record<string, unknown>;
    expect(r).toMatchObject({ nuevos: 0, criticos: 0, avisados: 0 });
    expect(h.destinatarios).not.toHaveBeenCalled();
    expect(notificador.avisar).not.toHaveBeenCalled();
  });

  it("un crítico nuevo avisa en vivo; si el aviso falla, la captura sigue y no hay rechazo sin atender", async () => {
    h.destinatarios.mockResolvedValue(["u-1"]);
    const rechazos: unknown[] = [];
    const alRechazar = (e: unknown): void => {
      rechazos.push(e);
    };
    process.on("unhandledRejection", alRechazar);
    try {
      const notificador = {
        avisar: vi.fn(async () => {
          throw new Error("Redis caído");
        }),
      };
      const { proc } = armar(
        [{ mensajes: [msg("m1", { codigoTipo: "REC" })], siguiente: null }],
        notificador,
      );
      const r = (await proc(ctx({}) as never)) as Record<string, unknown>;
      expect(r).toMatchObject({ nuevos: 1, criticos: 1, avisados: 1 });
      await new Promise((ok) => setTimeout(ok, 20));
      expect(notificador.avisar).toHaveBeenCalledTimes(1);
      expect(rechazos).toEqual([]);
    } finally {
      process.off("unhandledRejection", alRechazar);
    }
  });
});

describe("fallo del portal a mitad de la captura", () => {
  it("guarda la página que falló como cursor pendiente y propaga el error del portal", async () => {
    const falla = new ErrorTransitorio();
    const { proc } = armar([
      { mensajes: [msg("m1")], siguiente: "pag-2" },
      falla,
    ]);
    await expect(proc(ctx({}) as never)).rejects.toBe(falla);
    expect(h.guardarEstado).toHaveBeenCalledTimes(1);
    expect(h.guardarEstado.mock.calls[0]![2]).toEqual({
      cursorPendiente: "pag-2",
      sincronizado: false,
    });
  });

  it("si además falla guardar ese cursor, el error que sigue es el del portal (no el de la BD)", async () => {
    h.guardarEstado.mockRejectedValue(new Error("BD caída"));
    const falla = new ErrorTransitorio();
    const { proc } = armar([
      { mensajes: [msg("m1")], siguiente: "pag-2" },
      falla,
    ]);
    await expect(proc(ctx({}) as never)).rejects.toBe(falla);
    expect(h.guardarEstado).toHaveBeenCalledTimes(1);
  });

  it("un fallo en la primera página (sin nada confirmado) no guarda cursor", async () => {
    const falla = new ErrorTransitorio();
    const { proc } = armar([falla]);
    await expect(proc(ctx({}) as never)).rejects.toBe(falla);
    expect(h.guardarEstado).not.toHaveBeenCalled();
  });
});

// Spec 023, T15 (cobertura): ramas de `sol.buzon.abrir` que la integración no recorre. BD, portal y storage son dobles:
// parámetros inválidos, mensaje sin id de SUNAT, ids de adjunto repetidos y fallo al limpiar el storage.
import { randomBytes } from "node:crypto";
import { ErrorDatos } from "@contapp/sunat";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  mensaje: null as unknown,
  idSunat: null as string | null,
  guardar: vi.fn<(tx: unknown, p: unknown) => Promise<void>>(
    async () => undefined,
  ),
}));
vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  leerMensajeBuzon: vi.fn(async () => h.mensaje),
  leerIdSunatBuzon: vi.fn(async () => h.idSunat),
  estadoCredenciales: vi.fn(async () => [{ id: "cred-1", tipo: "sol" }]),
  guardarContenidoBuzon: h.guardar,
}));

import { abrirMensaje } from "./abrir-mensaje.js";

const MENSAJE = "0190a000-0000-7000-8000-00000000aaa1";
const VALIDOS = { mensajeId: MENSAJE };
const trabajo = (parametros: unknown) => ({
  id: "j-1",
  tenantId: "0190a000-0000-7000-8000-0000000000e1",
  clienteId: "0190a000-0000-7000-8000-0000000000c1",
  ruc: "20700000002",
  tipo: "sol.buzon.abrir",
  parametros,
  intentos: 0,
  creadoPor: "u-1",
});
const ctx = (parametros: unknown) => ({
  trabajo: trabajo(parametros),
  conToken: async <T>(f: (t: string) => Promise<T>) => f("tok"),
});

const pdf = (relleno = 16): Uint8Array =>
  Buffer.concat([Buffer.from("%PDF-1.7\n", "latin1"), randomBytes(relleno)]);

function armar(
  recibido: unknown,
  storage?: {
    guardar?: ReturnType<typeof vi.fn>;
    eliminar?: ReturnType<typeof vi.fn>;
  },
) {
  const secreto = {
    usar: <T>(f: (v: unknown) => T): T => f({ usuario: "u", clave: "c" }),
    destruir: vi.fn(),
  };
  const solPortal = { obtenerMensaje: vi.fn(async () => recibido) };
  const st = {
    guardar: storage?.guardar ?? vi.fn(async () => undefined),
    eliminar: storage?.eliminar ?? vi.fn(async () => undefined),
  };
  const proc = abrirMensaje({
    db: {
      withTenant: async (_c: unknown, f: (tx: unknown) => unknown) => f({}),
    } as never,
    servicio: { descifrarCredencial: vi.fn(async () => secreto) } as never,
    solPortal: solPortal as never,
    storage: st as never,
  });
  return { proc, solPortal, st };
}

beforeEach(() => {
  h.mensaje = { contenidoRuta: null, adjuntos: [] };
  h.idSunat = "M-0001";
  h.guardar.mockReset();
  h.guardar.mockResolvedValue(undefined);
});

describe("parámetros y mensaje", () => {
  it.each([
    undefined,
    null,
    {},
    { mensajeId: "no-es-uuid" },
    { mensajeId: MENSAJE, extra: 1 },
  ])(
    "parámetros inválidos (%j): ErrorDatos sin tocar la BD ni el portal",
    async (parametros) => {
      const { proc, solPortal } = armar({});
      await expect(proc(ctx(parametros) as never)).rejects.toBeInstanceOf(
        ErrorDatos,
      );
      expect(solPortal.obtenerMensaje).not.toHaveBeenCalled();
      expect(h.guardar).not.toHaveBeenCalled();
    },
  );

  it("el mensaje existe pero no tiene id de SUNAT: ErrorDatos sin llamar al portal", async () => {
    h.idSunat = null;
    const { proc, solPortal, st } = armar({});
    await expect(proc(ctx(VALIDOS) as never)).rejects.toBeInstanceOf(
      ErrorDatos,
    );
    expect(solPortal.obtenerMensaje).not.toHaveBeenCalled();
    expect(st.guardar).not.toHaveBeenCalled();
  });

  it("mensaje inexistente: ErrorDatos", async () => {
    h.mensaje = null;
    const { proc, solPortal } = armar({});
    await expect(proc(ctx(VALIDOS) as never)).rejects.toBeInstanceOf(
      ErrorDatos,
    );
    expect(solPortal.obtenerMensaje).not.toHaveBeenCalled();
  });
});

describe("adjuntos con id repetido", () => {
  it("cuenta el primero de cada id, sea guardado u omitido, y respeta el orden de llegada", async () => {
    const primero = pdf();
    const { proc, st } = armar({
      contenido: { formato: "texto", cuerpo: "Hola" },
      marcaLeido: false,
      adjuntos: [
        { idSunat: "A1", nombre: "uno.pdf", bytes: primero },
        { idSunat: "A1", nombre: "uno-bis.pdf", bytes: pdf(32) },
        { idSunat: "A1", nombre: "uno-omitido.pdf", omitido: "tamano" },
        { idSunat: "A2", nombre: "dos.bin", omitido: "tamano" },
        { idSunat: "A2", nombre: "dos-bis.bin", omitido: "tamano" },
        {
          idSunat: "A3",
          nombre: "tres.exe",
          bytes: Buffer.from("MZ-no-permitido"),
        },
      ],
    });
    await proc(ctx(VALIDOS) as never);
    expect(h.guardar).toHaveBeenCalledTimes(1);
    const args = h.guardar.mock.calls[0]![1] as {
      adjuntos: {
        idSunat: string;
        nombre: string;
        ruta: string | null;
        omitido: string | null;
      }[];
    };
    expect(args.adjuntos.map((a) => a.idSunat)).toEqual(["A1", "A2", "A3"]);
    expect(args.adjuntos.map((a) => a.nombre)).toEqual([
      "uno.pdf",
      "dos.bin",
      "tres.exe",
    ]);
    expect(args.adjuntos.map((a) => a.omitido)).toEqual([
      null,
      "tamano",
      "mime",
    ]);
    expect(args.adjuntos[0]!.ruta).not.toBeNull();
    expect(args.adjuntos[1]!.ruta).toBeNull();
    // Contenido + un solo archivo de adjunto: el repetido no se escribe.
    expect(st.guardar).toHaveBeenCalledTimes(2);
  });
});

describe("limpieza del storage ante un fallo", () => {
  it("si la BD falla y borrar un archivo también falla, el error original es el que sigue", async () => {
    const original = new Error("fallo de BD");
    h.guardar.mockRejectedValue(original);
    const eliminar = vi.fn(async () => {
      throw new Error("no se pudo borrar");
    });
    const { proc, st } = armar(
      {
        contenido: { formato: "texto", cuerpo: "Hola" },
        marcaLeido: true,
        adjuntos: [{ idSunat: "A1", nombre: "uno.pdf", bytes: pdf() }],
      },
      { eliminar },
    );
    await expect(proc(ctx(VALIDOS) as never)).rejects.toBe(original);
    expect(st.guardar).toHaveBeenCalledTimes(2);
    expect(eliminar).toHaveBeenCalledTimes(2);
  });
});

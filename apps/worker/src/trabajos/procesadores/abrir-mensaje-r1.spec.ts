// Spec 023 · T17 (rojo) · H-023-1-3, segunda parte (RF-126). Un fallo de datos de la BD ocurrido DESPUÉS de `obtenerMensaje` no se
// reintenta: el procesador lanza `ErrorDatos` (clase `datos`, motivo `datos_invalidos`, sin reintento en el ejecutor) y el portal se
// llamó una sola vez, porque cada llamada puede marcar el mensaje como leído en SUNAT. Lo escrito en el storage se borra. BD, portal y
// storage son dobles. Falla hoy porque el error de PostgreSQL sigue tal cual al ejecutor, que lo trata como transitorio y reintenta.
import { randomBytes } from "node:crypto";
import { ErrorDatos, clasificarError } from "@contapp/sunat";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  guardar: vi.fn<(tx: unknown, p: unknown) => Promise<void>>(
    async () => undefined,
  ),
}));
vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  leerMensajeBuzon: vi.fn(async () => ({ contenidoRuta: null, adjuntos: [] })),
  leerIdSunatBuzon: vi.fn(async () => "M-0001"),
  estadoCredenciales: vi.fn(async () => [{ id: "cred-1", tipo: "sol" }]),
  guardarContenidoBuzon: h.guardar,
}));

import { abrirMensaje } from "./abrir-mensaje.js";

const MENSAJE = "0190a000-0000-7000-8000-00000000aaa1";
const ctx = {
  trabajo: {
    id: "j-1",
    tenantId: "0190a000-0000-7000-8000-0000000000e1",
    clienteId: "0190a000-0000-7000-8000-0000000000c1",
    ruc: "20700000002",
    tipo: "sol.buzon.abrir",
    parametros: { mensajeId: MENSAJE },
    intentos: 0,
    creadoPor: "u-1",
  },
  conToken: async <T>(f: (t: string) => Promise<T>) => f("tok"),
};

const pdf = (): Uint8Array =>
  Buffer.concat([Buffer.from("%PDF-1.7\n", "latin1"), randomBytes(16)]);

function armar() {
  const secreto = {
    usar: <T>(f: (v: unknown) => T): T => f({ usuario: "u", clave: "c" }),
    destruir: vi.fn(),
  };
  const solPortal = {
    obtenerMensaje: vi.fn(async () => ({
      idSunat: "M-0001",
      contenido: { formato: "texto", cuerpo: "Hola" },
      marcaLeido: true,
      adjuntos: [{ idSunat: "A1", nombre: "uno.pdf", bytes: pdf() }],
    })),
  };
  const storage = {
    guardar: vi.fn(async () => undefined),
    eliminar: vi.fn(async () => undefined),
  };
  const proc = abrirMensaje({
    db: {
      withTenant: async (_c: unknown, f: (tx: unknown) => unknown) => f({}),
    } as never,
    servicio: { descifrarCredencial: vi.fn(async () => secreto) } as never,
    solPortal: solPortal as never,
    storage: storage as never,
  });
  return { proc, solPortal, storage };
}

const errorPg = (code: string): Error =>
  Object.assign(new Error(`error de PostgreSQL ${code}`), { code });

beforeEach(() => {
  h.guardar.mockReset();
  h.guardar.mockResolvedValue(undefined);
});

describe("H-023-1-3 · fallo de datos tras obtenerMensaje (RF-126)", () => {
  it.each([
    ["22021", "carácter inválido (NUL) en un texto"],
    ["22001", "texto más largo que la columna"],
    ["23514", "CHECK de la tabla"],
    ["23505", "clave única"],
  ])(
    "PostgreSQL %s (%s): ErrorDatos de motivo datos_invalidos, portal llamado una vez y storage limpio",
    async (code) => {
      h.guardar.mockRejectedValue(errorPg(code));
      const { proc, solPortal, storage } = armar();
      const fallo = await proc(ctx as never).then(
        () => null,
        (e: unknown) => e,
      );
      expect(fallo).toBeInstanceOf(ErrorDatos);
      expect(clasificarError(fallo)).toEqual({
        clase: "datos",
        motivo: "datos_invalidos",
      });
      // Sin reintento no hay segunda llamada: la única llamada ya pudo marcar el mensaje como leído.
      expect(solPortal.obtenerMensaje).toHaveBeenCalledTimes(1);
      // Contenido y adjunto escritos, y ambos borrados.
      expect(storage.guardar).toHaveBeenCalledTimes(2);
      expect(storage.eliminar).toHaveBeenCalledTimes(2);
    },
  );
});

// Spec 025 (T14a): ramas de `ImportacionesService.importar` que no se alcanzan por HTTP, con la capa de datos y el encolador simulados:
// cuerpo ausente (equivale a `{}`: 6 periodos), importación que desaparece antes de leerse y encolado que no llega a escribir.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Alcance } from "@contapp/db";
import type { SesionResuelta } from "../auth/auth.service.js";
import { AccesoError } from "../acceso/errores.js";
import type { Encolador } from "../trabajos/encolador.js";

const m = vi.hoisted(() => ({
  iniciarImportacion: vi.fn(),
  fijarTrabajoImportacion: vi.fn(),
  ultimaImportacion: vi.fn(),
  leerEstadoCredenciales: vi.fn(),
  exigirCliente: vi.fn(),
}));

vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  iniciarImportacion: m.iniciarImportacion,
  fijarTrabajoImportacion: m.fijarTrabajoImportacion,
  ultimaImportacion: m.ultimaImportacion,
  leerEstadoCredenciales: m.leerEstadoCredenciales,
}));
vi.mock("./apoyo.js", async (original) => ({
  ...(await original<typeof import("./apoyo.js")>()),
  exigirCliente: m.exigirCliente,
}));

const { ImportacionesService } = await import("./importaciones.service.js");

const sesion = { usuarioId: "u1", tenantActivo: "t1" } as unknown as SesionResuelta;
const alcance: Alcance = { tipo: "global" };
const tx = {};
const db = { withTenant: async (_ctx: unknown, fn: (t: unknown) => Promise<unknown>) => fn(tx) };

/** Encolador simulado: `escribe` indica si ejecuta el segundo paso en la transacción (la escritura del trabajo en la fila). */
function encolador(escribe: boolean): Encolador {
  return {
    encolarCon: async (_ctx: unknown, _e: unknown, antes: (t: unknown) => Promise<void>, despues: (t: unknown, r: unknown) => Promise<void>) => {
      const r = { trabajo: { id: "trabajo-1" } };
      await antes(tx);
      if (escribe) await despues(tx, r);
      return r;
    },
  } as unknown as Encolador;
}

async function codigoDe(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AccesoError);
    return (e as AccesoError).getResponse();
  }
  throw new Error("debía fallar");
}

beforeEach(() => {
  vi.resetAllMocks();
  m.exigirCliente.mockResolvedValue(undefined);
  m.leerEstadoCredenciales.mockResolvedValue([
    { tipo: "sol", estado: "configurada" },
    { tipo: "sire_api", estado: "configurada" },
  ]);
  m.iniciarImportacion.mockResolvedValue("imp-1");
  m.fijarTrabajoImportacion.mockResolvedValue(undefined);
});

describe("ImportacionesService.importar: ramas internas", () => {
  it.each([undefined, null])("un cuerpo %s se trata como {}: pide los 6 periodos por omisión", async (cuerpo) => {
    m.ultimaImportacion.mockResolvedValue(null);
    const s = new ImportacionesService(db as never, encolador(true));
    await codigoDe(s.importar(sesion, alcance, "c1", cuerpo));
    expect(m.iniciarImportacion).toHaveBeenCalledTimes(1);
    const { periodos } = m.iniciarImportacion.mock.calls[0]![1] as { periodos: string[] };
    expect(periodos).toHaveLength(6);
  });

  it("si la importación recién creada ya no se lee dentro de la transacción: 404 no_encontrado", async () => {
    m.ultimaImportacion.mockResolvedValue(null);
    const s = new ImportacionesService(db as never, encolador(true));
    expect(await codigoDe(s.importar(sesion, alcance, "c1", { periodos: 3 }))).toMatchObject({ codigo: "no_encontrado" });
    expect(m.fijarTrabajoImportacion).toHaveBeenCalledWith(tx, { importacionId: "imp-1", trabajoId: "trabajo-1" });
  });

  it("si el encolado termina sin dejar la importación vista: 404 no_encontrado, nunca una respuesta vacía", async () => {
    const s = new ImportacionesService(db as never, encolador(false));
    expect(await codigoDe(s.importar(sesion, alcance, "c1", {}))).toMatchObject({ codigo: "no_encontrado" });
    expect(m.fijarTrabajoImportacion).not.toHaveBeenCalled();
  });

  it("un cuerpo que no cumple el esquema es 400 solicitud_invalida y no crea nada", async () => {
    const s = new ImportacionesService(db as never, encolador(true));
    expect(await codigoDe(s.importar(sesion, alcance, "c1", { periodos: 99 }))).toMatchObject({ codigo: "solicitud_invalida" });
    expect(m.iniciarImportacion).not.toHaveBeenCalled();
  });
});

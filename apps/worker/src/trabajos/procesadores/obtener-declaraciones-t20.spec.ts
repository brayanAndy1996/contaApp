// Spec 026 · T20 (backend): ramas de H-026-2-1 sin BD ni Redis. Una presentación que la función acotada rechazaría deja su periodo
// «sin declaración» (el resto se registra) y un 22023 de `prorrata_declaraciones_registrar` es `ErrorDatos` (sin reintento).
import { ErrorDatos } from "@contapp/sunat";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  class ProrrataRepoError extends Error {
    readonly codigo: string;
    constructor(codigo: string) {
      super(`Error de base de datos en prorrata (SQLSTATE ${codigo})`);
      this.name = "ProrrataRepoError";
      this.codigo = codigo;
    }
  }
  return {
    ProrrataRepoError,
    registrar: vi.fn<(tx: unknown, e: unknown) => Promise<number>>(async () => 0),
    credenciales: vi.fn(async () => [{ id: "cred-1", tipo: "sol" }]),
  };
});
vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  estadoCredenciales: h.credenciales,
  registrarDeclaraciones: h.registrar,
  ProrrataRepoError: h.ProrrataRepoError,
}));

import { obtenerDeclaraciones } from "./obtener-declaraciones.js";

const PERIODO = "202610";
const decl = (periodo: string, o: Record<string, unknown> = {}) => ({
  periodo,
  numeroOrden: "1",
  fechaPresentacion: "2026-11-10",
  tipo: "original" as const,
  ventasGravadasBase: "100000.00",
  ventasGravadasIgv: "18000.00",
  exportaciones: "0.00",
  noGravadas: "20000.00",
  igvAdquisicionesDg: "9000.00",
  igvAdquisicionesDgng: "3600.00",
  prorrataUsada: null,
  ...o,
});

function armar(respuestas: Record<string, unknown[]>) {
  const secreto = { usar: <T>(f: (v: unknown) => T): T => f({ usuario: "usu", clave: "cla" }), destruir: vi.fn() };
  const solPortal = {
    obtenerDeclaraciones621: vi.fn(async (_c: unknown, o: { periodo: string }) => respuestas[o.periodo] ?? [decl(o.periodo)]),
    listarMensajes: vi.fn(),
    obtenerMensaje: vi.fn(),
  };
  const db = { withTenant: async (_c: unknown, f: (tx: unknown) => Promise<unknown>) => f({}) };
  const proc = obtenerDeclaraciones({
    db: db as never,
    servicio: { descifrarCredencial: vi.fn(async () => secreto) } as never,
    solPortal: solPortal as never,
  });
  const ctx = {
    trabajo: {
      id: "0190a000-0000-7000-8000-0000000000a1",
      tenantId: "0190a000-0000-7000-8000-0000000000e1",
      clienteId: "0190a000-0000-7000-8000-0000000000c1",
      ruc: "20700000002",
      tipo: "sol.declaraciones.descargar",
      parametros: { periodo: PERIODO },
      intentos: 0,
      creadoPor: null,
    },
    conToken: async <T>(f: (t: string) => Promise<T>) => f("tok"),
  };
  return { correr: () => proc(ctx as never) as Promise<Record<string, unknown>>, solPortal };
}

beforeEach(() => {
  h.registrar.mockReset();
  h.registrar.mockResolvedValue(11);
  h.credenciales.mockResolvedValue([{ id: "cred-1", tipo: "sol" }]);
});

describe("H-026-2-1 · presentaciones que la función acotada rechazaría", () => {
  it("número de orden 0 en 202608: ese periodo queda sin declaración y los otros 11 se registran", async () => {
    const { correr, solPortal } = armar({ "202608": [decl("202608", { numeroOrden: "0" })] });
    const r = await correr();
    expect(solPortal.obtenerDeclaraciones621).toHaveBeenCalledTimes(12);
    const e = h.registrar.mock.calls[0]?.[1] as { sinDeclaracion: string[]; declaraciones: { periodo: string }[] };
    expect(e.sinDeclaracion).toEqual(["202608"]);
    expect(e.declaraciones).toHaveLength(11);
    expect(e.declaraciones.some((d) => d.periodo === "202608")).toBe(false);
    expect(r).toEqual({ periodosLeidos: 12, sinDeclaracion: 1, nuevas: 11 });
  });

  it("un 22023 de la función acotada es ErrorDatos (determinista: sin reintento ni `sunat_no_responde`)", async () => {
    h.registrar.mockRejectedValue(new h.ProrrataRepoError("22023"));
    const { correr } = armar({});
    await expect(correr()).rejects.toBeInstanceOf(ErrorDatos);
  });
});

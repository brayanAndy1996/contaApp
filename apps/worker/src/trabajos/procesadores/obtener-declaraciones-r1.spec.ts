// Spec 026 · T16 (tester): H-026-1-3 en el worker (R-1: M no puede ser posterior al mes en curso en hora de Lima). Sin BD ni Redis: BD,
// credenciales y portal son dobles. Un trabajo con periodo futuro (payload forjado o desfase de reloj entre backend y worker) falla con
// `ErrorDatos` ANTES de ubicar la credencial, descifrarla, llamar al puerto SOL o escribir. El reloj se fija con fake timers (`Date`):
// «mes en curso» es el de Lima (UTC-5), no el de UTC.
import { ErrorDatos } from "@contapp/sunat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  registrar: vi.fn<(tx: unknown, e: unknown) => Promise<number>>(async () => 0),
  credenciales: vi.fn(async (): Promise<{ id: string; tipo: string }[]> => [
    { id: "cred-1", tipo: "sol" },
  ]),
}));
vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  estadoCredenciales: h.credenciales,
  registrarDeclaraciones: h.registrar,
}));

import { obtenerDeclaraciones } from "./obtener-declaraciones.js";

const trabajo = (periodo: string) => ({
  id: "0190a000-0000-7000-8000-0000000000a1",
  tenantId: "0190a000-0000-7000-8000-0000000000e1",
  clienteId: "0190a000-0000-7000-8000-0000000000c1",
  ruc: "20700000002",
  tipo: "sol.declaraciones.descargar",
  parametros: { periodo },
  intentos: 0,
  creadoPor: null,
});

function armar() {
  const secreto = {
    usar: <T>(f: (v: unknown) => T): T => f({ usuario: "usu", clave: "cla" }),
    destruir: vi.fn(),
  };
  const descifrar = vi.fn(async () => secreto);
  const solPortal = {
    obtenerDeclaraciones621: vi.fn(async () => []),
    listarMensajes: vi.fn(),
    obtenerMensaje: vi.fn(),
  };
  const db = {
    withTenant: async (_c: unknown, f: (tx: unknown) => Promise<unknown>) =>
      f({}),
  };
  const proc = obtenerDeclaraciones({
    db: db as never,
    servicio: { descifrarCredencial: descifrar } as never,
    solPortal: solPortal as never,
  });
  const correr = (periodo: string) =>
    proc({
      trabajo: trabajo(periodo),
      conToken: async <T>(f: (t: string) => Promise<T>) => f("tok"),
    } as never);
  return { correr, descifrar, solPortal };
}

beforeEach(() => {
  h.registrar.mockReset();
  h.registrar.mockResolvedValue(0);
  h.credenciales.mockReset();
  h.credenciales.mockResolvedValue([{ id: "cred-1", tipo: "sol" }]);
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("H-026-1-3 · periodo posterior al mes en curso en Lima", () => {
  it.each([
    ["2026-11-22T17:00:00Z", "202612"],
    ["2026-11-22T17:00:00Z", "202701"],
    ["2026-12-31T12:00:00Z", "202701"],
    // Lima va 5 horas detras de UTC: el 1 de diciembre 03:00 UTC todavia es 30 de noviembre en Lima, asi que diciembre es futuro.
    ["2026-12-01T03:00:00Z", "202612"],
  ])(
    "con el reloj en %s el periodo %s falla con ErrorDatos sin descifrar, sin llamar a SOL y sin escribir",
    async (ahora, periodo) => {
      vi.setSystemTime(new Date(ahora));
      const { correr, descifrar, solPortal } = armar();
      await expect(correr(periodo)).rejects.toBeInstanceOf(ErrorDatos);
      expect(descifrar).not.toHaveBeenCalled();
      expect(solPortal.obtenerDeclaraciones621).not.toHaveBeenCalled();
      expect(h.registrar).not.toHaveBeenCalled();
    },
  );

  it.each([
    // El mes en curso y el anterior siguen siendo validos (control: R-1 es «M <= mes en curso»), tambien en el borde UTC/Lima.
    ["2026-11-22T17:00:00Z", "202611"],
    ["2026-11-22T17:00:00Z", "202610"],
    ["2026-12-01T03:00:00Z", "202611"],
    ["2027-01-01T04:59:00Z", "202612"],
  ])(
    "con el reloj en %s el periodo %s se procesa: 12 llamadas a SOL y una escritura",
    async (ahora, periodo) => {
      vi.setSystemTime(new Date(ahora));
      const { correr, descifrar, solPortal } = armar();
      await correr(periodo);
      expect(descifrar).toHaveBeenCalledTimes(1);
      expect(solPortal.obtenerDeclaraciones621).toHaveBeenCalledTimes(12);
      expect(h.registrar).toHaveBeenCalledTimes(1);
    },
  );
});

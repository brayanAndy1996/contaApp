// Spec 024 (T16a): el detalle sin BD cuando la atención desaparece entre leer el mensaje y leer su estado.
// La carrera real (un borrado entre las dos lecturas de la misma transacción) no se puede provocar con la BD; la rama se fija aquí.
import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  leerMensajeBuzon: vi.fn(),
  detalleAtencion: vi.fn(),
  auditarBuzon: vi.fn(),
}));
vi.mock("./apoyo.js", async (original) => ({
  ...(await original<typeof import("./apoyo.js")>()),
  exigirCliente: vi.fn(async () => undefined),
}));

import { detalleAtencion, leerMensajeBuzon } from "@contapp/db";
import type { SesionResuelta } from "../auth/auth.service.js";
import { LecturaBuzonService } from "./lectura.service.js";

const T = "0190a000-0000-7000-8000-0000000000a1";
const U = "0190a000-0000-7000-8000-0000000000b1";
const C = "0190a000-0000-7000-8000-0000000000c1";
const M = "0190a000-0000-7000-8000-0000000000d1";
const sesion = { tenantActivo: T, usuarioId: U } as SesionResuelta;
const global = { tipo: "global" } as const;
const MENSAJE = {
  id: M,
  asunto: "Aviso",
  remitente: "SUNAT",
  fecha: new Date("2026-11-10T15:00:00Z"),
  categoria: "otros",
  critico: false,
  motivoCritico: null,
  leidoEnSunat: false,
  contenidoObtenido: false,
  adjuntosDeclarados: 0,
  contenidoRuta: null,
  adjuntos: [],
};

function armar() {
  const withTenant = vi.fn((_c: unknown, fn: (tx: unknown) => unknown) => Promise.resolve(fn({})));
  return new LecturaBuzonService({ withTenant } as never, {} as never);
}
const codigo = (p: Promise<unknown>): Promise<unknown> => p.then(() => "ok", (e: { codigo?: string }) => e.codigo);

beforeEach(() => vi.resetAllMocks());

describe("detalle · atención desaparecida", () => {
  it("si la atención ya no existe, el mensaje es no_encontrado (404), igual que uno inexistente", async () => {
    vi.mocked(leerMensajeBuzon).mockResolvedValue(MENSAJE as never);
    vi.mocked(detalleAtencion).mockResolvedValue(null);
    expect(await codigo(armar().detalle(sesion, global, C, M))).toBe("no_encontrado");
  });

  it("si el mensaje no existe, no_encontrado sin leer la atención", async () => {
    vi.mocked(leerMensajeBuzon).mockResolvedValue(null);
    expect(await codigo(armar().detalle(sesion, global, C, M))).toBe("no_encontrado");
    expect(detalleAtencion).not.toHaveBeenCalled();
  });
});

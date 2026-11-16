// Spec 022 (T6, RP-3, CA-8): excluir y restaurar leen UNA venta por id (`leerFilaVenta`) y ya no todo el periodo
// (`leerFilasVentas`). Sin BD: se espía qué lectura usa el servicio y con qué argumentos; el contrato HTTP lo cubre
// `exclusion-rp3.int.spec.ts` y `exclusion.int.spec.ts`.
import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  excluirVenta: vi.fn(),
  restaurarVenta: vi.fn(),
  leerClienteDto: vi.fn(),
  leerFilasVentas: vi.fn(),
  leerFilaVenta: vi.fn(),
}));
vi.mock("@contapp/domain", async (original) => ({
  ...(await original<typeof import("@contapp/domain")>()),
  erroresDeFilaVenta: vi.fn(),
  ventaAFila: vi.fn(),
}));
vi.mock("./apoyo.js", async (original) => ({
  ...(await original<typeof import("./apoyo.js")>()),
  exigirEscrituraVentas: vi.fn().mockResolvedValue(undefined),
}));

import { excluirVenta, leerClienteDto, leerFilasVentas, leerFilaVenta, restaurarVenta, type Alcance } from "@contapp/db";
import { erroresDeFilaVenta } from "@contapp/domain";
import type { SesionResuelta } from "../auth/auth.service.js";
import { ExclusionVentasService } from "./exclusion.service.js";

const TENANT = "0190a000-0000-7000-8000-0000000000a1";
const ACTOR = "0190a000-0000-7000-8000-0000000000b1";
const CLIENTE = "0190a000-0000-7000-8000-0000000000c1";
const VENTA = "0190a000-0000-7000-8000-0000000000d1";
const sesion = { tenantActivo: TENANT, usuarioId: ACTOR } as SesionResuelta;
const alcance: Alcance = { tipo: "global" };
const PERMISOS: ReadonlySet<string> = new Set(["sire.clasificar"]);
const TX = { tx: true };

function armar() {
  const withTenant = vi.fn((_c: unknown, fn: (tx: unknown) => unknown) => Promise.resolve(fn(TX)));
  return new ExclusionVentasService({ withTenant } as never);
}
const excluir = (id = VENTA) => armar().excluir(sesion, alcance, PERMISOS, CLIENTE, "202610", id, { motivo: "boleta duplicada" });
const restaurar = (id = VENTA) => armar().restaurar(sesion, alcance, PERMISOS, CLIENTE, "202610", id, {});

const fila = (exclusion: unknown = null) => ({
  id: VENTA,
  origen: "sire",
  tipo: "03",
  serie: "D001",
  numero: "1",
  fecha: "2026-10-05",
  tipoDocContraparte: "0",
  docContraparte: "-",
  moneda: "PEN",
  tipoCambio: null,
  baseGravada: "100.00",
  igv: "18.00",
  exonerada: "0.00",
  inafecta: "0.00",
  isc: "0.00",
  icbper: "0.00",
  otros: "0.00",
  total: "119.00",
  exclusion,
});

beforeEach(() => {
  vi.mocked(excluirVenta).mockReset().mockResolvedValue({ motivo: "boleta duplicada", excluidaPor: ACTOR, excluidaEn: new Date("2026-10-05T10:00:00Z") } as never);
  vi.mocked(restaurarVenta).mockReset().mockResolvedValue(true);
  vi.mocked(leerFilasVentas).mockReset();
  vi.mocked(leerFilaVenta).mockReset().mockResolvedValue(fila() as never);
  vi.mocked(leerClienteDto).mockResolvedValue({ ruc: "20100000001" } as never);
  vi.mocked(erroresDeFilaVenta).mockReturnValue([{ codigo: "IGV" }] as never);
});

describe("CA-8 · excluir lee la venta por id", () => {
  it("usa leerFilaVenta(tx, cliente, periodo, ventaId) y no lee todo el periodo", async () => {
    await excluir();
    expect(leerFilaVenta).toHaveBeenCalledTimes(1);
    expect(leerFilaVenta).toHaveBeenCalledWith(TX, CLIENTE, "202610", VENTA);
    expect(leerFilasVentas).not.toHaveBeenCalled();
  });

  it("sin fila (otro cliente, otro periodo o RLS) es 404 no_encontrado y no excluye", async () => {
    vi.mocked(leerFilaVenta).mockResolvedValue(null as never);
    await expect(excluir()).rejects.toMatchObject({ codigo: "no_encontrado" });
    expect(excluirVenta).not.toHaveBeenCalled();
    expect(leerFilasVentas).not.toHaveBeenCalled();
  });

  it("un id mal formado es 404 sin consultar nada", async () => {
    await expect(excluir("' or 1=1 --")).rejects.toMatchObject({ codigo: "no_encontrado" });
    expect(leerFilaVenta).not.toHaveBeenCalled();
    expect(leerFilasVentas).not.toHaveBeenCalled();
  });
});

describe("CA-8 · restaurar lee la venta por id", () => {
  it("usa leerFilaVenta y no lee todo el periodo", async () => {
    vi.mocked(leerFilaVenta).mockResolvedValue(fila({ motivo: "x", por: ACTOR, en: new Date("2026-10-05T10:00:00Z") }) as never);
    await restaurar();
    expect(leerFilaVenta).toHaveBeenCalledWith(TX, CLIENTE, "202610", VENTA);
    expect(restaurarVenta).toHaveBeenCalledWith(TX, VENTA, ACTOR);
    expect(leerFilasVentas).not.toHaveBeenCalled();
  });

  it("sin fila es 404 no_encontrado", async () => {
    vi.mocked(leerFilaVenta).mockResolvedValue(null as never);
    await expect(restaurar()).rejects.toMatchObject({ codigo: "no_encontrado" });
    expect(restaurarVenta).not.toHaveBeenCalled();
    expect(leerFilasVentas).not.toHaveBeenCalled();
  });

  it("una venta no excluida es 409 no_excluida", async () => {
    await expect(restaurar()).rejects.toMatchObject({ codigo: "no_excluida" });
    expect(restaurarVenta).not.toHaveBeenCalled();
  });

  it("un id mal formado es 404 sin consultar nada", async () => {
    await expect(restaurar("abc")).rejects.toMatchObject({ codigo: "no_encontrado" });
    expect(leerFilaVenta).not.toHaveBeenCalled();
  });
});

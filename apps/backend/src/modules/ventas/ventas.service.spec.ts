// Spec 013 (T13) · `VentasService` sin BD: las ramas defensivas que las pruebas de integración no alcanzan (carreras entre la
// lectura y la escritura, errores inesperados del dominio o de la BD, fila legible por el zod pero no por el dominio).
// El contrato HTTP completo lo cubren los `*.int.spec.ts` de este módulo.
import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  bloquearPeriodoLibro: vi.fn(),
  clienteVisible: vi.fn(),
  crearVentaManual: vi.fn(),
  justificar: vi.fn(),
  leerClienteDto: vi.fn(),
  leerFilasVentas: vi.fn(),
  listarJustificados: vi.fn(),
  quitarVentaManual: vi.fn(),
  revertirJustificacion: vi.fn(),
}));
vi.mock("@contapp/domain", async (original) => ({
  ...(await original<typeof import("@contapp/domain")>()),
  resumirVentas: vi.fn(),
}));

import {
  clienteVisible,
  crearVentaManual,
  leerClienteDto,
  leerFilasVentas,
  listarJustificados,
  quitarVentaManual,
  revertirJustificacion,
  VentasRepoError,
} from "@contapp/db";
import { MontoFueraDeRangoError, resumirVentas } from "@contapp/domain";
import type { Alcance } from "@contapp/db";
import type { SesionResuelta } from "../auth/auth.service.js";
import { VentasService } from "./ventas.service.js";

const TENANT = "0190a000-0000-7000-8000-0000000000a1";
const ACTOR = "0190a000-0000-7000-8000-0000000000b1";
const CLIENTE = "0190a000-0000-7000-8000-0000000000c1";
const VENTA = "0190a000-0000-7000-8000-0000000000d1";
const sesion = { tenantActivo: TENANT, usuarioId: ACTOR } as SesionResuelta;
const alcance: Alcance = { tipo: "global" };
const encolador = { encolar: vi.fn() };

function armar() {
  const withTenant = vi.fn((_c: unknown, fn: (tx: unknown) => unknown) => Promise.resolve(fn({ tx: true })));
  return new VentasService({ withTenant } as never, encolador as never);
}

const cuerpoVenta = {
  tipo: "03",
  serie: "B001",
  numero: "291",
  fechaEmision: "2026-10-05",
  moneda: "PEN",
  docContraparte: "-",
  baseGravada: "100.00",
  igv: "18.00",
  exonerada: "0.00",
  inafecta: "0.00",
  isc: "0.00",
  icbper: "0.00",
  otros: "0.00",
  total: "118.00",
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(clienteVisible).mockResolvedValue(true);
  vi.mocked(leerClienteDto).mockResolvedValue({ archivado: false } as never);
});

describe("cliente fuera del alcance o que desapareció entre el guard y la transacción", () => {
  it("una lectura responde no_encontrado cuando clienteVisible dice que no", async () => {
    vi.mocked(clienteVisible).mockResolvedValue(false);
    await expect(armar().resumen(sesion, alcance, CLIENTE, "202610")).rejects.toMatchObject({ codigo: "no_encontrado" });
    expect(leerFilasVentas).not.toHaveBeenCalled();
  });

  it("una escritura responde no_encontrado si el cliente ya no existe y no escribe nada", async () => {
    vi.mocked(leerClienteDto).mockResolvedValue(null);
    await expect(armar().agregar(sesion, alcance, CLIENTE, "202610", cuerpoVenta)).rejects.toMatchObject({
      codigo: "no_encontrado",
    });
    expect(crearVentaManual).not.toHaveBeenCalled();
  });
});

describe("resumen", () => {
  it("una suma fuera de NUMERIC(14,2) es el 422 controlado resumen_fuera_de_rango, no un 500", async () => {
    vi.mocked(leerFilasVentas).mockResolvedValue([]);
    vi.mocked(resumirVentas).mockImplementation(() => {
      throw new MontoFueraDeRangoError();
    });
    const e = await armar().resumen(sesion, alcance, CLIENTE, "202610").catch((x: unknown) => x);
    expect(e).toMatchObject({ status: 422, response: { codigo: "resumen_fuera_de_rango" } });
  });

  it("cualquier otro error del dominio se propaga sin disfrazarlo", async () => {
    vi.mocked(leerFilasVentas).mockResolvedValue([]);
    vi.mocked(resumirVentas).mockImplementation(() => {
      throw new RangeError("inesperado");
    });
    await expect(armar().resumen(sesion, alcance, CLIENTE, "202610")).rejects.toBeInstanceOf(RangeError);
  });
});

describe("agregar", () => {
  it("una fila que el zod acepta pero el dominio no (documento con símbolo) es 400 solicitud_invalida y no escribe", async () => {
    await expect(
      armar().agregar(sesion, alcance, CLIENTE, "202610", { ...cuerpoVenta, docContraparte: "=CMD()" }),
    ).rejects.toMatchObject({ codigo: "solicitud_invalida" });
    expect(crearVentaManual).not.toHaveBeenCalled();
  });

  it("un error de la BD que no es la clave repetida se propaga (no se disfraza de duplicado)", async () => {
    vi.mocked(crearVentaManual).mockRejectedValue(new VentasRepoError("23514"));
    await expect(armar().agregar(sesion, alcance, CLIENTE, "202610", cuerpoVenta)).rejects.toMatchObject({
      codigo: "23514",
    });
  });
});

describe("quitar y revertir: la fila desaparece entre la lectura y la escritura", () => {
  it("quitar responde no_encontrado si el DELETE no borró nada", async () => {
    vi.mocked(leerFilasVentas).mockResolvedValue([{ id: VENTA, origen: "manual" }] as never);
    vi.mocked(quitarVentaManual).mockResolvedValue(false);
    await expect(armar().quitar(sesion, alcance, CLIENTE, "202610", VENTA)).rejects.toMatchObject({
      codigo: "no_encontrado",
    });
  });

  it("revertir responde no_encontrado si otra solicitud la revirtió justo antes", async () => {
    vi.mocked(listarJustificados).mockResolvedValue([{ id: VENTA }] as never);
    vi.mocked(revertirJustificacion).mockResolvedValue(false);
    await expect(armar().revertir(sesion, alcance, CLIENTE, "202610", VENTA)).rejects.toMatchObject({
      codigo: "no_encontrado",
    });
  });
});

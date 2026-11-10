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
  leerEstadoPeriodoVentas: vi.fn(),
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
  leerEstadoPeriodoVentas,
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
const SIN_PERMISOS: ReadonlySet<string> = new Set<string>();
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
  vi.mocked(leerEstadoPeriodoVentas).mockResolvedValue({ estado: "abierto", marcadoPor: null, marcadoEn: null });
});

describe("cliente fuera del alcance o que desapareció entre el guard y la transacción", () => {
  it("una lectura responde no_encontrado cuando clienteVisible dice que no", async () => {
    vi.mocked(clienteVisible).mockResolvedValue(false);
    await expect(armar().resumen(sesion, alcance, CLIENTE, "202610")).rejects.toMatchObject({ codigo: "no_encontrado" });
    expect(leerFilasVentas).not.toHaveBeenCalled();
  });

  it("una escritura responde no_encontrado si el cliente ya no existe y no escribe nada", async () => {
    vi.mocked(leerClienteDto).mockResolvedValue(null);
    await expect(armar().agregar(sesion, alcance, SIN_PERMISOS, CLIENTE, "202610", cuerpoVenta)).rejects.toMatchObject({
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
      armar().agregar(sesion, alcance, SIN_PERMISOS, CLIENTE, "202610", { ...cuerpoVenta, docContraparte: "=CMD()" }),
    ).rejects.toMatchObject({ codigo: "solicitud_invalida" });
    expect(crearVentaManual).not.toHaveBeenCalled();
  });

  it("un error de la BD que no es la clave repetida se propaga (no se disfraza de duplicado)", async () => {
    vi.mocked(crearVentaManual).mockRejectedValue(new VentasRepoError("23514"));
    await expect(armar().agregar(sesion, alcance, SIN_PERMISOS, CLIENTE, "202610", cuerpoVenta)).rejects.toMatchObject({
      codigo: "23514",
    });
  });
});

describe("quitar y revertir: la fila desaparece entre la lectura y la escritura", () => {
  it("quitar responde no_encontrado si el DELETE no borró nada", async () => {
    vi.mocked(leerFilasVentas).mockResolvedValue([{ id: VENTA, origen: "manual" }] as never);
    vi.mocked(quitarVentaManual).mockResolvedValue(false);
    await expect(armar().quitar(sesion, alcance, SIN_PERMISOS, CLIENTE, "202610", VENTA)).rejects.toMatchObject({
      codigo: "no_encontrado",
    });
  });

  it("revertir responde no_encontrado si otra solicitud la revirtió justo antes", async () => {
    vi.mocked(listarJustificados).mockResolvedValue([{ id: VENTA }] as never);
    vi.mocked(revertirJustificacion).mockResolvedValue(false);
    await expect(armar().revertir(sesion, alcance, SIN_PERMISOS, CLIENTE, "202610", VENTA)).rejects.toMatchObject({
      codigo: "no_encontrado",
    });
  });
});

describe("correlatividad: justificacionId de cada faltante (desvío autorizado de T13)", () => {
  const filas = (numeros: string[]) => numeros.map((numero) => ({ tipo: "03", serie: "B001", numero }));
  const salto = (id: string, desde: number, hasta: number) => ({
    id,
    tipo: "03",
    serie: "B001",
    desde,
    hasta,
    comentario: `salto ${id}`,
  });
  async function faltantes(numeros: string[], justificados: ReturnType<typeof salto>[]) {
    vi.mocked(leerFilasVentas).mockResolvedValue(filas(numeros) as never);
    vi.mocked(listarJustificados).mockResolvedValue(justificados as never);
    const r = await armar().correlatividad(sesion, alcance, CLIENTE, "202610");
    return r.series[0]!.faltantes;
  }

  it("lo justifica una sola: el faltante lleva el id de esa justificación", async () => {
    expect(await faltantes(["290", "292"], [salto("j-1", 291, 291)])).toEqual([
      { desde: 291, hasta: 291, estado: "justificado", comentario: "salto j-1", justificacionId: "j-1" },
    ]);
  });

  it("una justificación más ancha que el hueco lo cubre: lleva su id", async () => {
    const f = await faltantes(["290", "294"], [salto("j-1", 200, 300)]);
    expect(f[0]).toMatchObject({ desde: 291, hasta: 293, estado: "justificado", justificacionId: "j-1" });
  });

  it("pendiente, parcial y cubierto por varias a la vez: sin id (no hay una sola que revertir)", async () => {
    expect(await faltantes(["290", "292"], [])).toEqual([{ desde: 291, hasta: 291, estado: "pendiente" }]);
    const parcial = await faltantes(["290", "294"], [salto("j-1", 291, 291)]);
    expect(parcial[0]).toMatchObject({ estado: "parcial" });
    expect(parcial[0]).not.toHaveProperty("justificacionId");
    const varias = await faltantes(["290", "294"], [salto("j-1", 291, 292), salto("j-2", 293, 293)]);
    expect(varias[0]).toMatchObject({ estado: "justificado" });
    expect(varias[0]).not.toHaveProperty("justificacionId");
  });

  it("dos justificaciones que cubren sola al faltante: el id es el de la que el dominio eligió (la de menor desde)", async () => {
    const f = await faltantes(["290", "292"], [salto("j-b", 291, 291), salto("j-a", 280, 295)]);
    expect(f[0]).toMatchObject({ comentario: "salto j-a", justificacionId: "j-a" });
  });
});

// Spec 026 (T14a): `LecturaProrrataService.vista` sin BD. Solo una suma que no cabe en NUMERIC(14,2) (`MontoFueraDeRangoError`) es el 422
// controlado `resumen_fuera_de_rango` (cubierto por `rango.int.spec.ts`); cualquier otro error se propaga tal cual (el filtro global
// lo responde 500 sin detalle) y no se disfraza de error de dinero.
import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  leerDeclaraciones: vi.fn(),
  leerManuales: vi.fn(),
  leerTotalesVentasProrrata: vi.fn(),
  leerUltimaObtencion: vi.fn(),
  leerUsada: vi.fn(),
  listarPropuestas: vi.fn(),
}));
vi.mock("./apoyo.js", async (original) => ({
  ...(await original<typeof import("./apoyo.js")>()),
  exigirCliente: vi.fn(),
}));
vi.mock("./vistas.js", async (original) => ({
  ...(await original<typeof import("./vistas.js")>()),
  armarVista: vi.fn(),
}));

import {
  leerDeclaraciones,
  leerManuales,
  leerTotalesVentasProrrata,
  leerUltimaObtencion,
  leerUsada,
  listarPropuestas,
} from "@contapp/db";
import { MontoFueraDeRangoError } from "@contapp/domain";
import { ComprasError } from "../compras/errores.js";
import { LecturaProrrataService } from "./lectura.service.js";
import { armarVista } from "./vistas.js";

const SESION = { tenantActivo: "0190a000-0000-7000-8000-0000000000a1", usuarioId: "0190a000-0000-7000-8000-0000000000b1" } as never;
const CLIENTE = "8F14E45F-CEEA-467F-A8E0-0C6A6C1D4F10";
const db = { withTenant: (_ctx: unknown, f: (tx: unknown) => Promise<unknown>) => f({}) } as never;
const compras = { igvVigente: vi.fn() } as never;

describe("LecturaProrrataService.vista: errores al armar la vista", () => {
  beforeEach(() => {
    vi.mocked(leerDeclaraciones).mockResolvedValue([]);
    vi.mocked(leerManuales).mockResolvedValue([]);
    vi.mocked(leerTotalesVentasProrrata).mockResolvedValue([]);
    vi.mocked(leerUltimaObtencion).mockResolvedValue(null);
    vi.mocked(leerUsada).mockResolvedValue(null);
    vi.mocked(listarPropuestas).mockResolvedValue([]);
    vi.mocked(armarVista).mockReset();
  });

  const vista = () => new LecturaProrrataService(db, compras).vista(SESION, { tipo: "global" }, CLIENTE, "202601");

  it("un error que no es de dinero se propaga tal cual, sin convertirlo en resumen_fuera_de_rango", async () => {
    const boom = new Error("falla inesperada");
    vi.mocked(armarVista).mockRejectedValue(boom);
    const e = await vista().catch((x: unknown) => x);
    expect(e).toBe(boom);
    expect(e).not.toBeInstanceOf(ComprasError);
  });

  it("MontoFueraDeRangoError es 422 resumen_fuera_de_rango", async () => {
    vi.mocked(armarVista).mockRejectedValue(new MontoFueraDeRangoError());
    const e = await vista().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ComprasError);
    expect((e as ComprasError).codigo).toBe("resumen_fuera_de_rango");
    expect((e as ComprasError).getStatus()).toBe(422);
  });

  it("el cliente se lee en minúsculas en todas las consultas de la lectura", async () => {
    vi.mocked(armarVista).mockResolvedValue({} as never);
    await vista();
    expect(vi.mocked(leerDeclaraciones).mock.calls[0]?.[1]).toBe(CLIENTE.toLowerCase());
    expect(vi.mocked(leerUsada).mock.calls[0]?.[1]).toBe(CLIENTE.toLowerCase());
  });
});

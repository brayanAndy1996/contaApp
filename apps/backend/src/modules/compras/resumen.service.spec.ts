// Spec 014 (T16, cierra la cobertura de T15): `ResumenComprasService` sin BD. Un error que no es de dinero no se disfraza de
// `resumen_fuera_de_rango`: se propaga (el filtro global lo responde 500 sin detalle). El 422 de una suma que no cabe lo cubre
// `acciones-borde.int.spec.ts`.
import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  leerEstadoPeriodo: vi.fn(),
  leerLoteParaResumen: vi.fn(),
}));
vi.mock("./apoyo.js", async (original) => ({
  ...(await original<typeof import("./apoyo.js")>()),
  exigirCliente: vi.fn(),
}));

import { leerEstadoPeriodo, leerLoteParaResumen } from "@contapp/db";
import { ComprasError } from "./errores.js";
import { ResumenComprasService } from "./resumen.service.js";

const SESION = { tenantActivo: "0190a000-0000-7000-8000-0000000000a1", usuarioId: "0190a000-0000-7000-8000-0000000000b1" } as never;
const db = { withTenant: (_ctx: unknown, f: (tx: unknown) => Promise<unknown>) => f({}) } as never;

describe("ResumenComprasService", () => {
  beforeEach(() => {
    vi.mocked(leerEstadoPeriodo).mockResolvedValue({ estado: "abierto", marcadoPor: null, marcadoEn: null });
    vi.mocked(leerLoteParaResumen).mockReset();
  });

  it("un periodo sin compras da cero en todo", async () => {
    vi.mocked(leerLoteParaResumen).mockResolvedValue([]);
    const r = await new ResumenComprasService(db).resumen(SESION, { tipo: "global" }, "c", "202610");
    expect(r.estado).toBe("abierto");
    expect(r.conIgv.n).toBe(0);
    expect(r.casilleros.vigente.total).toBe("0.00");
  });

  it("un error inesperado de lectura se propaga tal cual", async () => {
    const boom = new TypeError("boom");
    vi.mocked(leerLoteParaResumen).mockRejectedValue(boom);
    await expect(new ResumenComprasService(db).resumen(SESION, { tipo: "global" }, "c", "202610")).rejects.toBe(boom);
    await expect(new ResumenComprasService(db).resumen(SESION, { tipo: "global" }, "c", "202610")).rejects.not.toBeInstanceOf(ComprasError);
  });
});

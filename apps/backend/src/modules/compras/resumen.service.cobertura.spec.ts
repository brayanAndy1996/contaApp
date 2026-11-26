// Spec 030 (T14): comportamiento público de `ResumenComprasService.igvVigente` que `resumen.service.spec.ts` no ejercita (rama que
// el umbral de 90 % del backend deja al descubierto): un total negativo (notas de crédito) y un periodo con más de un lote.
import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  leerEstadoPeriodo: vi.fn(),
  leerLoteParaResumen: vi.fn(),
}));

import { leerEstadoPeriodo, leerLoteParaResumen, type CompraParaResumen } from "@contapp/db";
import { ResumenComprasService } from "./resumen.service.js";

const db = { withTenant: (_ctx: unknown, f: (tx: unknown) => Promise<unknown>) => f({}) } as never;
const tx = {} as never;
const montos = (igvDg: string) => ({
  biDg: "0.00", igvDg, biDgng: "0.00", igvDgng: "0.00", biDng: "0.00", igvDng: "0.00",
  noGravado: "0.00", isc: "0.00", icbper: "0.00", otrosTributos: "0.00", total: igvDg,
});
const compra = (id: string, igvDg: string): CompraParaResumen =>
  ({ id, origen: "sire", moneda: "PEN", tipoCambio: null, excluida: false, original: montos(igvDg), vigente: montos(igvDg) }) as CompraParaResumen;

beforeEach(() => {
  vi.mocked(leerEstadoPeriodo).mockResolvedValue({ estado: "abierto", marcadoPor: null, marcadoEn: null });
  vi.mocked(leerLoteParaResumen).mockReset();
});

describe("ResumenComprasService.igvVigente · totales negativos y varios lotes", () => {
  it("un periodo con más notas de crédito que facturas da un IGV negativo exacto en céntimos", async () => {
    vi.mocked(leerLoteParaResumen).mockResolvedValueOnce([compra("a", "10.00"), compra("b", "-15.05")]);
    const r = await new ResumenComprasService(db).igvVigente(tx, "c", "202610");
    expect(r.igvDg).toBe("-5.05");
  });

  it("un lote lleno obliga a leer el siguiente desde el último id y se suman ambos", async () => {
    const lleno = Array.from({ length: 2000 }, (_, i) => compra(`id-${String(i).padStart(4, "0")}`, "0.01"));
    vi.mocked(leerLoteParaResumen).mockResolvedValueOnce(lleno).mockResolvedValueOnce([compra("z", "0.05")]);
    const r = await new ResumenComprasService(db).igvVigente(tx, "c", "202610");
    expect(r.igvDg).toBe("20.05");
    expect(vi.mocked(leerLoteParaResumen)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(leerLoteParaResumen).mock.calls[1]![3]).toBe("id-1999");
  });
});

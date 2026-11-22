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

import { Money } from "@contapp/domain";
import { leerEstadoPeriodo, leerLoteParaResumen, type CompraParaResumen } from "@contapp/db";
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

// Spec 026 (T23a, CA-12): `igvVigente` real, con las lecturas de `@contapp/db` simuladas. Cubre el `catch` que traduce una suma fuera
// de NUMERIC(14,2) a `resumen_fuera_de_rango` y relanza cualquier otro error tal cual.
// El total es la suma de los tres IGV (única columna con valor): así las filas USD cuadran y se convierten.
const montos = (igvDg: string, igvDgng = "0.00", igvDng = "0.00") => ({
  biDg: "0.00", igvDg, biDgng: "0.00", igvDgng, biDng: "0.00", igvDng,
  noGravado: "0.00", isc: "0.00", icbper: "0.00", otrosTributos: "0.00",
  total: Money.suma([igvDg, igvDgng, igvDng].map((v) => Money.desde(v, "PEN")), "PEN").toString(),
});
const compra = (id: string, igv: ReturnType<typeof montos>, extra: Partial<CompraParaResumen> = {}): CompraParaResumen =>
  ({ id, origen: "sire", moneda: "PEN", tipoCambio: null, excluida: false, original: igv, vigente: igv, ...extra }) as CompraParaResumen;

describe("ResumenComprasService.igvVigente (026, CA-12)", () => {
  const tx = {} as never;
  beforeEach(() => {
    vi.mocked(leerEstadoPeriodo).mockResolvedValue({ estado: "abierto", marcadoPor: null, marcadoEn: null });
    vi.mocked(leerLoteParaResumen).mockReset();
  });

  it("suma el IGV vigente de las PEN en céntimos exactos, sin las excluidas, y devuelve el estado", async () => {
    vi.mocked(leerLoteParaResumen).mockResolvedValueOnce([
      compra("a", montos("100.10", "5.05", "1.00")),
      compra("b", montos("-20.05", "0.10", "2.00")),
      compra("c", montos("999.00"), { excluida: true }),
    ]);
    const r = await new ResumenComprasService(db).igvVigente(tx, "c", "202610");
    expect(r).toEqual({ igvDg: "80.05", igvDgng: "5.15", igvDng: "3.00", estado: "abierto" });
  });

  it("un periodo sin compras da cero", async () => {
    vi.mocked(leerLoteParaResumen).mockResolvedValue([]);
    const r = await new ResumenComprasService(db).igvVigente(tx, "c", "202610");
    expect(r).toEqual({ igvDg: "0.00", igvDgng: "0.00", igvDng: "0.00", estado: "abierto" });
  });

  it("una suma fuera de NUMERIC(14,2) es `resumen_fuera_de_rango` (ComprasError), no un error de dominio", async () => {
    // Dos USD con tipo de cambio 1.000: cada una cabe, su suma en PEN no (`MontoFueraDeRangoError` del dominio).
    vi.mocked(leerLoteParaResumen).mockResolvedValueOnce([
      compra("a", montos("999999999999.99"), { moneda: "USD", tipoCambio: "1.000" }),
      compra("b", montos("999999999999.99"), { moneda: "USD", tipoCambio: "1.000" }),
    ]);
    const p = new ResumenComprasService(db).igvVigente(tx, "c", "202610");
    await expect(p).rejects.toBeInstanceOf(ComprasError);
    await expect(p).rejects.toMatchObject({ codigo: "resumen_fuera_de_rango" });
  });

  it("las USD con tipo de cambio se convierten fila a fila y se suman a las PEN", async () => {
    vi.mocked(leerLoteParaResumen).mockResolvedValueOnce([
      compra("a", montos("10.00")),
      compra("b", montos("100.00", "0.00", "0.00"), { moneda: "USD", tipoCambio: "3.500" }),
    ]);
    const r = await new ResumenComprasService(db).igvVigente(tx, "c", "202610");
    expect(r.igvDg).toBe("360.00");
  });

  it("un error ajeno de lectura se relanza tal cual", async () => {
    const boom = new TypeError("boom");
    vi.mocked(leerLoteParaResumen).mockRejectedValue(boom);
    const p = new ResumenComprasService(db).igvVigente(tx, "c", "202610");
    await expect(p).rejects.toBe(boom);
    await expect(p).rejects.not.toBeInstanceOf(ComprasError);
  });
});

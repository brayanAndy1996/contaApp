/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON dinámicos en pruebas */
// Spec 026 (T12): el IGV de las compras de M que usa la prorrata (`ResumenComprasService.igvVigente`) es el mismo del resumen de 014 aunque
// haya compras en USD (con y sin tipo de cambio), una excluida y una de IGV negativo (nota de crédito): mismas filas, misma conversión.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoProrrata,
  declaracionesCA1,
  facturaVenta,
  M,
  montosCompra,
  rutaComprasPeriodo,
  rutaVista,
  type Actor,
  type BancoProrrata,
  type Estudio,
} from "../../../test/soporte-prorrata.js";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

let v: BancoProrrata;
let E: Estudio;
let contador: Actor;

beforeAll(async () => {
  v = await abrirBancoProrrata();
  E = await v.estudio();
  contador = await v.b.c.p.b.miembro(E.tenantId, "contador");
});
afterAll(async () => {
  await v?.cerrar();
});

describe("IGV estimado de M · compras en USD, excluidas y negativas igual que el resumen de 014", () => {
  it("el crédito DG y el IGV DGNG y DNG de la prorrata son los casilleros vigentes del resumen de compras", async () => {
    const c = await v.cliente(E, { responsable: contador.id });
    await v.sembrarDeclaraciones(E.tenantId, c.id, declaracionesCA1(), { periodoHasta: M });
    await v.sembrarVentasSire(E.tenantId, c.id, M, [facturaVenta("F001", 1, "100000.00", "18000.00")], E.titular.id);
    const propuestaId = await v.sembrarPropuesta(E.tenantId, c.id, { periodo: M, libro: "compras", nuevas: 6, usuarioId: E.titular.id });
    const base = { periodo: M, propuestaId, usuarioId: E.titular.id };
    const compras: { numero: string; doc: string; extra: Record<string, unknown> }[] = [
      { numero: "1", doc: "20700001001", extra: { montos: montosCompra("DG", "1000.00", "180.00") } },
      { numero: "2", doc: "20700001002", extra: { montos: montosCompra("DGNG", "500.00", "90.00") } },
      { numero: "3", doc: "20700001003", extra: { montos: montosCompra("DNG", "250.00", "45.00") } },
      // USD con tipo de cambio: se convierte columna por columna (18.00 × 3.700 = 66.60).
      { numero: "4", doc: "20700001004", extra: { moneda: "USD", tipoCambio: "3.700", montos: montosCompra("DG", "100.00", "18.00") } },
      // USD sin tipo de cambio: no suma en ningún lado.
      { numero: "5", doc: "20700001005", extra: { moneda: "USD", tipoCambio: null, montos: montosCompra("DG", "100.00", "18.00") } },
      // Excluida: no suma.
      {
        numero: "6",
        doc: "20700001006",
        extra: { montos: montosCompra("DG", "2000.00", "360.00"), versiones: [{ excluida: true, motivo: "Duplicada", accion: "excluir" }] },
      },
    ];
    for (const k of compras) {
      await v.sembrarCompra(E.tenantId, c.id, { ...base, serie: "F020", numero: k.numero, doc: k.doc, ...k.extra } as any);
    }
    const r = await v.http(contador, "GET", rutaVista(c.id, M));
    expect(r.status, r.text).toBe(200);
    expect(r.body.igvEstimado.estado).toBe("calculado");
    const rc = await v.http(contador, "GET", `${rutaComprasPeriodo(c.id, M)}/resumen`);
    expect(rc.status, rc.text).toBe(200);
    const vigente = rc.body.casilleros.vigente;
    expect(vigente.igvDg).toBe("246.60"); // 180.00 + 66.60 (la excluida y la USD sin tipo de cambio no suman)
    expect(r.body.igvEstimado.creditoDg).toBe(vigente.igvDg);
    expect(r.body.igvEstimado.igvDgng).toBe(vigente.igvDgng);
    expect(r.body.igvEstimado.igvDng).toBe(vigente.igvDng);
  });

  it("sin compras en el periodo de M pero con propuesta cargada: IGV de compras en cero y el estado del periodo", async () => {
    const c = await v.cliente(E, { responsable: contador.id });
    await v.sembrarDeclaraciones(E.tenantId, c.id, declaracionesCA1(), { periodoHasta: M });
    await v.sembrarVentasSire(E.tenantId, c.id, M, [facturaVenta("F001", 1, "1000.00", "180.00")], E.titular.id);
    await v.sembrarPropuesta(E.tenantId, c.id, { periodo: M, libro: "compras", nuevas: 0, usuarioId: E.titular.id });
    const r = await v.http(contador, "GET", rutaVista(c.id, M));
    expect(r.status, r.text).toBe(200);
    expect(r.body.igvEstimado).toMatchObject({
      estado: "calculado",
      creditoDg: "0.00",
      igvDgng: "0.00",
      igvDng: "0.00",
      resultado: "180.00",
      situacion: "a_pagar",
      estadoPeriodoCompras: "abierto",
    });
  });
});

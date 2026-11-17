// Spec 021 · T20: correcciones de la ronda adversarial 2 (rojo) en el dominio. H-021-2-4: una fila de la descarga cuya suma de BI
// (o de IGV) al consolidar en el destino de la regla no cabe en NUMERIC(14,2) no tumba la planificación: R-HIS no la mueve (queda
// en su versión 1, coherente con la BD, que rechaza esa consolidación) y las demás filas se planifican igual. Falla hasta T21.
import { describe, expect, it } from "vitest";
import { fila, montos } from "../../tests/ayudas/filas-motor";
import { planificarHistorial } from "./r-his";
import type { FilaEvaluable, ReglaAprendidaEvaluable } from "./index";

const PROVEEDOR = { tipo: "6", numero: "20100000001" };
const regla: ReglaAprendidaEvaluable = {
  id: "regla-1",
  proveedor: { ...PROVEEDOR },
  destino: "DNG",
};
const MAXIMO = "999999999999.99";

const normal = (id: string): FilaEvaluable =>
  fila({
    id,
    proveedor: { ...PROVEEDOR },
    montos: montos("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.00" }),
  });
/** Cada columna cabe sola, pero BI de DG + BI de DGNG suman 1 000 000 000 000.00, fuera de NUMERIC(14,2). */
const desbordaBi = (id: string): FilaEvaluable =>
  fila({
    id,
    proveedor: { ...PROVEEDOR },
    montos: montos("PEN", { biDg: MAXIMO, biDgng: "0.01", total: MAXIMO }),
  });
/** Igual con los IGV de DG y de DGNG; el BI de la fila sí cabe. */
const desbordaIgv = (id: string): FilaEvaluable =>
  fila({
    id,
    proveedor: { ...PROVEEDOR },
    montos: montos("PEN", {
      biDg: "100.00",
      igvDg: MAXIMO,
      igvDgng: "0.01",
      total: MAXIMO,
    }),
  });

describe("H-021-2-4 · planificarHistorial con filas cuya consolidación desborda NUMERIC(14,2)", () => {
  it("no lanza: la fila con BI que desborda no se mueve y las demás sí", () => {
    const plan = planificarHistorial(
      [normal("a"), desbordaBi("b"), normal("c")],
      [regla],
      { rHisActiva: true },
    );
    expect(plan.map((p) => p.filaId)).toEqual(["a", "c"]);
  });

  it("no lanza: la fila con IGV que desborda no se mueve y las demás sí", () => {
    const plan = planificarHistorial([desbordaIgv("a"), normal("b")], [regla], {
      rHisActiva: true,
    });
    expect(plan.map((p) => p.filaId)).toEqual(["b"]);
  });

  it("varias filas del mismo proveedor, dos que desbordan entre medias: se mueven solo las que caben, en orden", () => {
    const plan = planificarHistorial(
      [normal("1"), desbordaBi("2"), desbordaIgv("3"), normal("4")],
      [regla],
      { rHisActiva: true },
    );
    expect(plan.map((p) => p.filaId)).toEqual(["1", "4"]);
    for (const p of plan) {
      expect(p.destino).toBe("DNG");
      expect(p.montos.obtener("biDng").toString()).toBe("100.00");
      expect(p.montos.total.toString()).toBe("118.00");
    }
  });

  it("la fila que desborda es solo la que no se mueve: sin ella en la descarga el plan es el mismo (no contagia a las demás)", () => {
    const con = planificarHistorial(
      [normal("a"), desbordaBi("x"), normal("b")],
      [regla],
      { rHisActiva: true },
    );
    const sin = planificarHistorial([normal("a"), normal("b")], [regla], {
      rHisActiva: true,
    });
    expect(
      con.map((p) => ({ ...p, montos: p.montos.total.toString() })),
    ).toEqual(sin.map((p) => ({ ...p, montos: p.montos.total.toString() })));
  });
});

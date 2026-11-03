// T10 (backend): bordes de R-RED no cubiertos por T5/T6b: rango NUMERIC(14,2), origen USD, grupos
// del XML que no explican la diferencia y explicaciones agregadas en T10.
import { describe, expect, it } from "vitest";
import { evaluar, fila, montos, pen, tc, unico, usd, xml } from "../../tests/ayudas/filas-motor";

const M = "999999999999.99";

describe("R-RED: bordes de rango (no lanza)", () => {
  it("origen USD cuya Σ excede el rango: sin sugerencia y explicación fija", () => {
    const origen = montos("USD", { biDg: M, igvDg: M, total: M });
    const m = montos("PEN", { biDg: "1.00", total: "1.00" });
    const h = unico(evaluar([fila({ montos: m, origenUsd: { montos: origen, tipoCambio: tc("3.750") } })]).hallazgos, "R-RED");
    expect(h.sugerencia).toBeNull();
    expect(h.explicacion).toBe("La suma de componentes no es igual al total y excede el rango de montos: revisar");
  });

  it("origen USD descuadrado explica su propio descuadre", () => {
    const origen = montos("USD", { biDg: "100.00", igvDg: "18.00", total: "119.00" });
    const m = montos("PEN", { biDg: "375.00", igvDg: "67.50", total: "442.50" });
    const h = unico(evaluar([fila({ montos: m, origenUsd: { montos: origen, tipoCambio: tc("3.750") } })]).hallazgos, "R-RED");
    expect(h.explicacion).toBe("La suma de componentes (118.00) no es igual al total (119.00): diferencia 1.00");
    expect(h.requiereConfirmacion).toBe(true);
  });

  it("conversión que excede el rango: sin sugerencia, explicación con el TC a tres decimales", () => {
    const origen = montos("USD", { biDg: M, total: M });
    const m = montos("PEN", { biDg: "1.00", total: "1.00" });
    const h = unico(evaluar([fila({ montos: m, origenUsd: { montos: origen, tipoCambio: tc("3.75") } })]).hallazgos, "R-RED");
    expect(h.sugerencia).toBeNull();
    expect(h.explicacion).toBe("Los montos en PEN no coinciden con la conversión por componente con TC 3.750");
  });

  it("con origenUsd la explicación nombra el TC", () => {
    const origen = montos("USD", { biDg: "100.00", igvDg: "18.00", total: "118.00" });
    const m = montos("PEN", { biDg: "375.00", igvDg: "67.51", total: "442.51" });
    const h = unico(evaluar([fila({ montos: m, origenUsd: { montos: origen, tipoCambio: tc("3.75") } })]).hallazgos, "R-RED");
    expect(h.explicacion).toBe("Los montos en PEN no coinciden con la conversión por componente con TC 3.750");
  });

  it("solo el total PEN difiere de la conversión: ajusta solo el total", () => {
    const origen = montos("USD", { noGravado: "10.00", total: "10.00" });
    const m = montos("PEN", { noGravado: "37.50", total: "37.51" });
    const h = unico(evaluar([fila({ montos: m, origenUsd: { montos: origen, tipoCambio: tc("3.750") } })]).hallazgos, "R-RED");
    expect(h.sugerencia).toEqual({ tipo: "ajustar", valores: { total: pen("37.50") } });
  });

  it("XML válido con suma parcial de grupo fuera de rango: sin sugerencia, no lanza", () => {
    const m = montos("PEN", { biDg: M, biDgng: M, noGravado: `-${M}`, total: "999999999999.98" });
    const x = xml({ total: pen("999999999999.98") });
    const h = unico(evaluar([fila({ montos: m, xml: x })]).hallazgos, "R-RED");
    expect(h.sugerencia).toBeNull();
    expect(h.requiereConfirmacion).toBe(true);
  });
});

describe("R-RED: umbral sin componentes y grupos del XML que no explican", () => {
  it("todas las columnas en 0 y total 0.01: umbral mínimo de 0.01, ajusta a 0.00", () => {
    const h = unico(evaluar([fila({ montos: montos("PEN", { total: "0.01" }) })]).hallazgos, "R-RED");
    expect(h.sugerencia).toEqual({ tipo: "ajustar", valores: { total: pen("0.00") } });
  });

  it("un solo grupo difiere pero no en la diferencia: sin sugerencia", () => {
    const m = montos("PEN", { biDg: "100.00", igvDg: "18.00", noGravado: "4.00", total: "123.00" });
    const x = xml({ noGravado: pen("6.00"), total: pen("123.00") });
    expect(unico(evaluar([fila({ montos: m, xml: x })]).hallazgos, "R-RED").sugerencia).toBeNull();
  });

  it("el grupo BI difiere pero está repartido en dos columnas: sin sugerencia", () => {
    const m = montos("PEN", { biDg: "50.00", biDgng: "49.00", igvDg: "18.00", total: "118.00" });
    const x = xml({ gravado: pen("100.00"), total: pen("118.00") });
    expect(unico(evaluar([fila({ montos: m, xml: x })]).hallazgos, "R-RED").sugerencia).toBeNull();
  });

  it("fila USD con XML USD que respalda la columna", () => {
    const m = montos("USD", { biDg: "100.00", igvDg: "18.00", isc: "1.00", total: "120.00" });
    const x = xml({
      moneda: "USD",
      gravado: usd("100.00"),
      igv: usd("18.00"),
      noGravado: usd("0.00"),
      isc: usd("2.00"),
      icbper: usd("0.00"),
      total: usd("120.00"),
    });
    const h = unico(evaluar([fila({ montos: m, xml: x })]).hallazgos, "R-RED");
    expect(h.sugerencia).toEqual({ tipo: "ajustar", valores: { isc: usd("2.00") } });
    expect(h.requiereConfirmacion).toBe(false);
  });
});

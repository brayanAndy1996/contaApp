// T14 (ronda 2): validación por marca privada, no por instanceof, y cuadre fuera de rango.
import { describe, expect, it } from "vitest";
import {
  Money,
  MontoInvalidoError,
  TASA_IGV_18,
  TOLERANCIA_CUADRE,
  igvCuadra,
  verificarCuadre,
} from "./index";
import type { Cuadrable } from "./index";

const pen = (s: string): Money => Money.desde(s, "PEN");
const falsoMoney = (): Money =>
  Object.freeze(Object.create(Money.prototype, { moneda: { value: "PEN" } })) as Money;

describe("marca privada de Money (R2a-4, R2b-2, R2b-6)", () => {
  it("igvCuadra acepta Money reales y rechaza un igv con el prototipo de Money sin estado", () => {
    expect(igvCuadra(pen("100.00"), pen("18.00"), TASA_IGV_18)).toBe(true);
    expect(() => igvCuadra(pen("100.00"), falsoMoney(), TASA_IGV_18)).toThrow(MontoInvalidoError);
  });

  it("verificarCuadre acepta un total real y rechaza uno con el prototipo de Money sin estado", () => {
    const fila = (total: Money): Cuadrable => ({
      moneda: "PEN",
      total,
      componentes: () => [pen("100.00"), pen("18.00")],
    });
    expect(verificarCuadre(fila(pen("118.00")), TOLERANCIA_CUADRE).cuadra).toBe(true);
    expect(() => verificarCuadre(fila(falsoMoney()), TOLERANCIA_CUADRE)).toThrow(MontoInvalidoError);
  });

  it("las clases y sus prototipos están congelados", () => {
    expect(Object.isFrozen(Money)).toBe(true);
    expect(Object.isFrozen(Money.prototype)).toBe(true);
  });
});

describe("igvCuadra con diferencia fuera de NUMERIC(14,2) (R2b-8)", () => {
  it("responde false en vez de lanzar; dentro de rango sigue respondiendo con la tolerancia", () => {
    expect(igvCuadra(pen("999999999999.99"), pen("-999999999999.99"), TASA_IGV_18)).toBe(false);
    expect(igvCuadra(pen("100.00"), pen("18.01"), TASA_IGV_18)).toBe(true);
  });
});

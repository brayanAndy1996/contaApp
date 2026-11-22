// Spec 026 (T8): la operación de división de montos de dinero/ (uso interno de prorrata/).
import { describe, expect, it } from "vitest";
import { porcentajeDeCociente } from "./cociente";
import { Money } from "./money";

const pen = (s: string) => Money.desde(s, "PEN");

describe("porcentajeDeCociente", () => {
  it("cociente exacto ×100 con redondeo mitad hacia arriba a 2 decimales", () => {
    expect(porcentajeDeCociente(pen("87345.00"), pen("100000.00"))).toBe("87.35");
    expect(porcentajeDeCociente(pen("1.00"), pen("3.00"))).toBe("33.33");
    expect(porcentajeDeCociente(pen("0.00"), pen("3.00"))).toBe("0.00");
    expect(porcentajeDeCociente(pen("-1.00"), pen("8.00"))).toBe("-12.50");
  });

  it("divisor cero o negativo, monedas distintas o un falso Money lanzan", () => {
    expect(() => porcentajeDeCociente(pen("1.00"), pen("0.00"))).toThrow();
    expect(() => porcentajeDeCociente(pen("1.00"), pen("-1.00"))).toThrow();
    expect(() => porcentajeDeCociente(pen("1.00"), Money.desde("1.00", "USD"))).toThrow();
    expect(() => porcentajeDeCociente({ moneda: "PEN" } as never, pen("1.00"))).toThrow();
  });
});

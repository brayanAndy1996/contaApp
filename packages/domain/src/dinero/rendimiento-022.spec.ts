import { describe, expect, it } from "vitest";
import { MontosComprobante } from "../comprobante/index";
import { Money, MontoFueraDeRangoError } from "./index";
import { esMontosReal } from "../reglas/entrada";

// Spec 022, RP-6 (T12): los atajos de rendimiento no cambian el resultado.
describe("RP-6: Money sin aritmética redundante", () => {
  it("el rango de NUMERIC(14,2) se respeta en el borde y justo después (con 11, 12 y 13 enteros)", () => {
    expect(Money.desde("99999999999.99", "PEN").toString()).toBe("99999999999.99");
    expect(Money.desde("100000000000.00", "PEN").toString()).toBe("100000000000.00");
    const tope = Money.desde("999999999999.99", "PEN");
    expect(tope.toString()).toBe("999999999999.99");
    expect(Money.desde("-999999999999.99", "PEN").toString()).toBe("-999999999999.99");
    expect(() => tope.sumar(Money.desde("0.01", "PEN"))).toThrow(MontoFueraDeRangoError);
    expect(() => Money.desde("0.01", "PEN").negar().restar(tope)).toThrow(MontoFueraDeRangoError);
    expect(() => Money.suma([tope, Money.desde("0.01", "PEN")], "PEN")).toThrow(MontoFueraDeRangoError);
  });

  it("toString es estable en llamadas repetidas y el cero negativo sigue siendo 0.00", () => {
    const m = Money.desde("1.5", "PEN");
    expect(m.toString()).toBe("1.50");
    expect(m.toString()).toBe("1.50");
    expect(JSON.stringify(m)).toBe('{"monto":"1.50","moneda":"PEN"}');
    expect(Money.desde("-0.00", "USD").toString()).toBe("0.00");
  });
});

describe("RP-6: esMontosReal sin suma decimal", () => {
  const real = MontosComprobante.desde("PEN", { total: "118.00", biDg: "100.00", igvDg: "18.00" });

  it("acepta un MontosComprobante real de su moneda", () => {
    expect(esMontosReal(real)).toBe(true);
    expect(esMontosReal(MontosComprobante.desde("USD", { total: "1.00" }))).toBe(true);
  });

  it("rechaza imitaciones, prototipos copiados, Proxy y monedas ajenas", () => {
    expect(esMontosReal(null)).toBe(false);
    expect(esMontosReal({ moneda: "PEN", total: real.total })).toBe(false);
    expect(esMontosReal(Object.create(MontosComprobante.prototype, { moneda: { value: "PEN" } }))).toBe(false);
    expect(esMontosReal(new Proxy(real, {}))).toBe(false);
    expect(esMontosReal(Object.create(real, { moneda: { value: "EUR" } }))).toBe(false);
  });
});

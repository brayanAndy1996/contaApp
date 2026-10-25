// Entradas mal formadas en tiempo de ejecución (llamadas desde JS sin tipos).
import { describe, expect, it } from "vitest";
import { MonedaDistintaError, Money, MontoInvalidoError, MovimientoInvalidoError } from "../dinero/index";
import { cambiarDestino } from "./cambiar-destino";
import type { ColumnaCompra, Destino } from "./columnas";
import { MontosComprobante } from "./montos-comprobante";
import { moverMonto } from "./mover-monto";

const base = (): MontosComprobante =>
  MontosComprobante.desde("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.00" });

describe("MontosComprobante: entradas mal formadas", () => {
  it("desde rechaza un objeto de valores ausente, nulo o arreglo", () => {
    for (const v of [null, undefined, "118.00", [], ["1.00"]]) {
      expect(() => MontosComprobante.desde("PEN", v as never)).toThrow(MontoInvalidoError);
    }
  });

  it("desde exige el total como propiedad propia (no heredada)", () => {
    expect(() => MontosComprobante.desde("PEN", { biDg: "1.00" } as never)).toThrow(MontoInvalidoError);
    const heredado = Object.create({ total: "1.00" }) as { total: string };
    expect(() => MontosComprobante.desde("PEN", heredado)).toThrow(MontoInvalidoError);
  });

  it("una columna heredada del prototipo no se toma en cuenta", () => {
    const v = Object.assign(Object.create({ biDg: "5.00" }) as object, { total: "0.00" });
    expect(MontosComprobante.desde("PEN", v as never).obtener("biDg").toString()).toBe("0.00");
  });

  it("desde rechaza una moneda desconocida", () => {
    expect(() => MontosComprobante.desde("EUR" as never, { total: "1.00" })).toThrow();
  });

  it("obtener con una columna desconocida lanza MontoInvalidoError", () => {
    expect(() => base().obtener("total" as ColumnaCompra)).toThrow(MontoInvalidoError);
    expect(() => base().obtener("toString" as ColumnaCompra)).toThrow(MontoInvalidoError);
  });

  it("sumar con algo que no es MontosComprobante lanza MonedaDistintaError", () => {
    const falso = { moneda: "PEN", total: Money.desde("1.00", "PEN") };
    expect(() => base().sumar(falso as never)).toThrow(MonedaDistintaError);
  });
});

describe("moverMonto / cambiarDestino: entradas mal formadas", () => {
  it("moverMonto con columna desconocida lanza MovimientoInvalidoError", () => {
    const pen = Money.desde("1.00", "PEN");
    expect(() => moverMonto(base(), "total" as ColumnaCompra, "isc", pen)).toThrow(MovimientoInvalidoError);
    expect(() => moverMonto(base(), "biDg", "total" as ColumnaCompra, pen)).toThrow(MovimientoInvalidoError);
  });

  it("moverMonto con un monto que no es Money lanza MonedaDistintaError", () => {
    const falso = { moneda: "PEN", toString: () => "1.00" };
    expect(() => moverMonto(base(), "biDg", "isc", falso as never)).toThrow(MonedaDistintaError);
  });

  it("cambiarDestino con destino desconocido lanza MovimientoInvalidoError", () => {
    expect(() => cambiarDestino(base(), "XX" as Destino)).toThrow(MovimientoInvalidoError);
  });
});

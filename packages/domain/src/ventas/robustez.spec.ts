// Spec 013 (T9): bordes de validarFilaVenta y resumirVentas que las pruebas de T3 no recorren.
import { describe, expect, it } from "vitest";
import { resumirVentas, validarFilaVenta } from "./index";

const buena = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  tipo: "03",
  serie: "B001",
  numero: "290",
  docContraparte: "-",
  fechaEmision: "2026-10-03",
  moneda: "PEN",
  baseGravada: "100.00",
  igv: "18.00",
  exonerada: "0.00",
  inafecta: "0.00",
  isc: "0.00",
  icbper: "0.00",
  otros: "0.00",
  total: "118.00",
  ...extra,
});

describe("validarFilaVenta · bordes", () => {
  it("el tipo de documento de la contraparte debe ser un solo carácter alfanumérico; ausente, nulo o vacío se omite", () => {
    for (const malo of ["66", "-", 6, {}]) {
      const r = validarFilaVenta(buena({ tipoDocContraparte: malo }));
      expect(r.ok, String(malo)).toBe(false);
      if (!r.ok) expect(r.errores).toEqual([{ campo: "tipoDocContraparte", codigo: "TIPO_DOCUMENTO_INVALIDO" }]);
    }
    for (const vacio of [undefined, null, ""]) {
      const r = validarFilaVenta(buena({ tipoDocContraparte: vacio }));
      expect(r.ok && Object.hasOwn(r.fila, "tipoDocContraparte")).toBe(false);
    }
    const r = validarFilaVenta(buena({ tipoDocContraparte: "A" }));
    expect(r.ok && r.fila.tipoDocContraparte).toBe("A");
  });

  it("un tipo de cambio que no es cadena falla en USD y en PEN, con su código", () => {
    const usd = validarFilaVenta(buena({ moneda: "USD", tipoCambio: 3.3 }));
    expect(usd.ok === false && usd.errores).toEqual([{ campo: "tipoCambio", codigo: "TIPO_CAMBIO_INVALIDO" }]);
    const pen = validarFilaVenta(buena({ moneda: "PEN", tipoCambio: "3.300" }));
    expect(pen.ok === false && pen.errores).toEqual([{ campo: "tipoCambio", codigo: "TIPO_CAMBIO_SOLO_EN_USD" }]);
  });

  it("con la moneda ilegible no se evalúa el tipo de cambio (un solo error)", () => {
    const r = validarFilaVenta(buena({ moneda: "EUR", tipoCambio: "abc" }));
    expect(r.ok === false && r.errores).toEqual([{ campo: "moneda", codigo: "MONEDA_INVALIDA" }]);
  });

  it("una suma que excede NUMERIC(14,2) no lanza: la fila es legible y no cuadra", () => {
    const r = validarFilaVenta(buena({ baseGravada: "999999999999.99", igv: "999999999999.99", total: "999999999999.99" }));
    expect(r.ok && r.cuadra).toBe(false);
  });

  it("los códigos de campo ausente y de fila inválida", () => {
    const sin = validarFilaVenta({});
    expect(sin.ok === false && sin.errores.every((e) => e.codigo === "CAMPO_OBLIGATORIO")).toBe(true);
    expect(validarFilaVenta(null)).toEqual({ ok: false, errores: [{ campo: "fila", codigo: "FILA_INVALIDA" }] });
  });
});

describe("resumirVentas · tipo de cambio ilegible", () => {
  it("una USD con un tipo de cambio que no se puede leer no se suma: sale en sinConvertir", () => {
    const r = resumirVentas([
      {
        clave: "01|F002|9",
        tipo: "01",
        moneda: "USD",
        tipoCambio: "abc",
        baseGravada: "1.00",
        igv: "0.18",
        exonerada: "0.00",
        inafecta: "0.00",
        isc: "0.00",
        icbper: "0.00",
        otros: "0.00",
        total: "1.18",
      },
    ]);
    expect(r.sinConvertir).toEqual([{ clave: "01|F002|9", moneda: "USD" }]);
    expect(r.avisos).toEqual(["usd_sin_tipo_cambio"]);
    expect(r.total.cantidad).toBe(0);
  });
});

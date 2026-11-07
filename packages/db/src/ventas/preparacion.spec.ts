// Unitarias de la preparación de ventas para el complemento (spec 013, D16): la normalización de lo recibido.
import { describe, expect, it } from "vitest";
import { existenteComplementable, prepararFilaVenta, tipoCambioConEscala, TIPO_DOC_AUSENTE } from "./preparacion";

const legible = {
  tipo: "03",
  serie: "B001",
  numero: "00290",
  docContraparte: "-",
  fechaEmision: "2026-10-03",
  moneda: "PEN" as const,
  baseGravada: "100.00",
  igv: "18.00",
  exonerada: "0.00",
  inafecta: "0.00",
  isc: "0.00",
  icbper: "0.00",
  otros: "0.00",
  total: "118.00",
};

describe("tipoCambioConEscala", () => {
  it.each([
    ["3", "3.000"],
    ["3.3", "3.300"],
    ["3.456", "3.456"],
  ])("%s -> %s", (e, s) => expect(tipoCambioConEscala(e)).toBe(s));
});

describe("prepararFilaVenta", () => {
  it("sin tipo de documento ni tipo de cambio: «0» y cadena vacía en lo comparable, nulo en lo que se guarda", () => {
    const p = prepararFilaVenta(legible, "03|B001|290");
    expect(p.clave).toBe("03|B001|290");
    expect(p.campos).toMatchObject({ tipoDocContraparte: TIPO_DOC_AUSENTE, tipoCambio: "", fechaEmision: "2026-10-03" });
    expect(p.datos).toMatchObject({ tipoDocContraparte: "0", tipoCambio: null, fecha: "2026-10-03", numero: "00290" });
  });

  it("con tipo de cambio y de documento: el tipo de cambio lleva los 3 decimales de la columna", () => {
    const p = prepararFilaVenta({ ...legible, moneda: "USD", tipoCambio: "3.3", tipoDocContraparte: "6" }, "03|B001|290");
    expect(p.campos).toMatchObject({ moneda: "USD", tipoCambio: "3.300", tipoDocContraparte: "6" });
    expect(p.datos.tipoCambio).toBe("3.300");
  });

  it("no incluye la razón social ni nada fuera de los 13 campos comparables", () => {
    expect(Object.keys(prepararFilaVenta(legible, "k").campos).sort()).toEqual(
      [
        "baseGravada", "docContraparte", "exonerada", "fechaEmision", "icbper", "igv", "inafecta", "isc", "moneda",
        "otros", "tipoCambio", "tipoDocContraparte", "total",
      ].sort(),
    );
  });
});

describe("existenteComplementable", () => {
  it("renombra la fecha de la columna al campo de FilaVentaSire", () => {
    expect(existenteComplementable({ clave: "k", origen: "manual", campos: { fecha: "2026-10-03", total: "1.00" } })).toEqual({
      clave: "k",
      origen: "manual",
      campos: { fechaEmision: "2026-10-03", total: "1.00" },
    });
  });
});

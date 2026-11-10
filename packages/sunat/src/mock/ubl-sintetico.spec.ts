import { describe, expect, it } from "vitest";
import type { ReferenciaXml } from "../puertos.js";
import type { PartesComprobante } from "./ruta-fixture.js";
import { generarUblSintetico } from "./ubl-sintetico.js";

// Spec 009 (D4): UBL sintético. Cubre la validación de la referencia y los tributos opcionales.
const COMP: PartesComprobante = {
  rucEmisor: "20700000011",
  tipo: "01",
  serie: "F001",
  numero: "1040",
};
const REF: ReferenciaXml = {
  fechaEmision: "2026-10-05",
  moneda: "PEN",
  baseGravada: "100.00",
  igv: "18.00",
  noGravado: "0.00",
  isc: "0.00",
  icbper: "0.00",
  otros: "0.00",
  total: "118.00",
};

describe("generarUblSintetico", () => {
  it("con una referencia simple deja los totales de la fila y sin cargos ni tipo de cambio", () => {
    const xml = generarUblSintetico(COMP, REF);
    expect(xml).toContain('<cbc:PayableAmount currencyID="PEN">118.00</cbc:PayableAmount>');
    expect(xml).toContain("<cbc:ID>F001-1040</cbc:ID>");
    expect(xml).not.toContain("ChargeTotalAmount");
    expect(xml).not.toContain("CalculationRate");
  });

  it("los otros cargos aparecen como ChargeTotalAmount", () => {
    const xml = generarUblSintetico(COMP, { ...REF, otros: "3.50", total: "121.50" });
    expect(xml).toContain('<cbc:ChargeTotalAmount currencyID="PEN">3.50</cbc:ChargeTotalAmount>');
  });

  it("USD sin tipo de cambio no incluye PaymentExchangeRate", () => {
    const xml = generarUblSintetico(COMP, { ...REF, moneda: "USD" });
    expect(xml).toContain('<cbc:DocumentCurrencyCode>USD</cbc:DocumentCurrencyCode>');
    expect(xml).not.toContain("PaymentExchangeRate");
  });

  it("una moneda fuera de PEN/USD lanza error", () => {
    expect(() => generarUblSintetico(COMP, { ...REF, moneda: "EUR" as never })).toThrow("moneda");
  });

  it("una fecha mal formada lanza error", () => {
    expect(() => generarUblSintetico(COMP, { ...REF, fechaEmision: "05/10/2026" })).toThrow("fecha");
  });

  it("un tipo de cambio mal formado lanza error sin eco del valor", () => {
    const f = (): string =>
      generarUblSintetico(COMP, { ...REF, moneda: "USD", tipoCambio: "3,30<x>" });
    expect(f).toThrow("tipoCambio");
    expect(f).not.toThrow("3,30");
  });
  it("con rucReceptor el receptor es ese RUC (tipo 6); sin él queda sin identificar", () => {
    const con = generarUblSintetico(COMP, { ...REF, rucReceptor: "20700000002" });
    expect(con).toContain('<cbc:AdditionalAccountID>6</cbc:AdditionalAccountID>');
    expect(con).toMatch(/<cac:AccountingCustomerParty>[\s\S]*?<cbc:ID schemeID="6">20700000002<\/cbc:ID>/);
    const sin = generarUblSintetico(COMP, REF);
    expect(sin).toMatch(/<cac:AccountingCustomerParty>[\s\S]*?<cbc:ID schemeID="0">-<\/cbc:ID>/);
  });

  it("un rucReceptor mal formado lanza error sin eco del valor", () => {
    const f = (): string => generarUblSintetico(COMP, { ...REF, rucReceptor: "2070<x>" });
    expect(f).toThrow("rucReceptor");
    expect(f).not.toThrow("2070");
  });
});

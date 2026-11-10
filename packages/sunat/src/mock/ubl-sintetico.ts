import { Money } from "@contapp/domain";
import type { PartesComprobante } from "./ruta-fixture.js";
import type { ReferenciaXml } from "../puertos.js";

/**
 * UBL 2.1 sintético (spec 009, D4): una línea, IGV 18 %, y totales, IGV y moneda iguales a la fila del SIRE
 * (`referencia`). Todo monto pasa por `Money` (nunca `number`). Datos inventados y marcados «PRUEBA».
 * Lanza `MontoInvalidoError` / `Error` si la `referencia` no cumple la gramática; el mock lo traduce a `ErrorDatos`.
 */

const RE_FECHA = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const RE_RUC = /^[0-9]{11}$/;
const RE_TIPO_CAMBIO = /^[0-9]{1,4}(\.[0-9]{1,3})?$/;

export function generarUblSintetico(
  c: PartesComprobante,
  ref: ReferenciaXml,
): string {
  const moneda = ref.moneda;
  if (moneda !== "PEN" && moneda !== "USD") throw new Error("moneda");
  if (!RE_FECHA.test(ref.fechaEmision)) throw new Error("fecha");
  if (ref.tipoCambio !== undefined && !RE_TIPO_CAMBIO.test(ref.tipoCambio)) {
    throw new Error("tipoCambio");
  }

  if (ref.rucReceptor !== undefined && !RE_RUC.test(ref.rucReceptor)) {
    throw new Error("rucReceptor");
  }
  // Con RUC del cliente, el receptor es ese RUC (tipo 6); sin él, queda sin identificar (tipo 0, "-").
  const receptorTipo = ref.rucReceptor === undefined ? "0" : "6";
  const receptorDoc = ref.rucReceptor ?? "-";

  const base = Money.desde(ref.baseGravada, moneda);
  const igv = Money.desde(ref.igv, moneda);
  const noGravado = Money.desde(ref.noGravado, moneda);
  const isc = Money.desde(ref.isc, moneda);
  const icbper = Money.desde(ref.icbper, moneda);
  const otros = Money.desde(ref.otros, moneda);
  const total = Money.desde(ref.total, moneda);

  const valorVenta = base.sumar(noGravado);
  const tributos = Money.suma([igv, isc, icbper], moneda);
  const m = (x: Money): string => x.toString();

  const subtotal = (
    imponible: Money,
    tributo: Money,
    id: string,
    nombre: string,
    categoria: string,
    pct: string,
  ): string => `
        <cac:TaxSubtotal>
          <cbc:TaxableAmount currencyID="${moneda}">${m(imponible)}</cbc:TaxableAmount>
          <cbc:TaxAmount currencyID="${moneda}">${m(tributo)}</cbc:TaxAmount>
          <cac:TaxCategory>
            <cbc:ID>${categoria}</cbc:ID>
            <cbc:Percent>${pct}</cbc:Percent>
            <cac:TaxScheme>
              <cbc:ID>${id}</cbc:ID>
              <cbc:Name>${nombre}</cbc:Name>
              <cbc:TaxTypeCode>VAT</cbc:TaxTypeCode>
            </cac:TaxScheme>
          </cac:TaxCategory>
        </cac:TaxSubtotal>`;

  const subtotales = [
    subtotal(base, igv, "1000", "IGV", "S", "18.00"),
    noGravado.esCero()
      ? ""
      : subtotal(noGravado, Money.cero(moneda), "9997", "EXO", "E", "0.00"),
    isc.esCero() ? "" : subtotal(valorVenta, isc, "2000", "ISC", "S", "0.00"),
    icbper.esCero()
      ? ""
      : subtotal(icbper, icbper, "7152", "ICBPER", "S", "0.00"),
  ].join("");

  const tipoCambio =
    moneda === "USD" && ref.tipoCambio !== undefined
      ? `
  <cac:PaymentExchangeRate>
    <cbc:SourceCurrencyCode>USD</cbc:SourceCurrencyCode>
    <cbc:TargetCurrencyCode>PEN</cbc:TargetCurrencyCode>
    <cbc:CalculationRate>${ref.tipoCambio}</cbc:CalculationRate>
  </cac:PaymentExchangeRate>`
      : "";

  const cargos = otros.esCero()
    ? ""
    : `
    <cbc:ChargeTotalAmount currencyID="${moneda}">${m(otros)}</cbc:ChargeTotalAmount>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Datos sintéticos (PRUEBA) generados por el mock. No es un comprobante real. -->
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>2.0</cbc:CustomizationID>
  <cbc:ID>${c.serie}-${c.numero}</cbc:ID>
  <cbc:IssueDate>${ref.fechaEmision}</cbc:IssueDate>
  <cbc:InvoiceTypeCode listID="0101">${c.tipo}</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>${moneda}</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty>
    <cbc:AdditionalAccountID>6</cbc:AdditionalAccountID>
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID schemeID="6">${c.rucEmisor}</cbc:ID>
      </cac:PartyIdentification>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>PRUEBA EMISOR SINTETICO</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cbc:AdditionalAccountID>${receptorTipo}</cbc:AdditionalAccountID>
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID schemeID="${receptorTipo}">${receptorDoc}</cbc:ID>
      </cac:PartyIdentification>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>PRUEBA CLIENTE SINTETICO</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>${tipoCambio}
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${moneda}">${m(tributos)}</cbc:TaxAmount>${subtotales}
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${moneda}">${m(valorVenta)}</cbc:LineExtensionAmount>
    <cbc:TaxInclusiveAmount currencyID="${moneda}">${m(total)}</cbc:TaxInclusiveAmount>${cargos}
    <cbc:PayableAmount currencyID="${moneda}">${m(total)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="NIU">1</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="${moneda}">${m(valorVenta)}</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="${moneda}">${m(tributos)}</cbc:TaxAmount>
    </cac:TaxTotal>
    <cac:Item>
      <cbc:Description>Producto sintético de prueba (PRUEBA)</cbc:Description>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="${moneda}">${m(valorVenta)}</cbc:PriceAmount>
    </cac:Price>
  </cac:InvoiceLine>
</Invoice>
`;
}

// UBL 2.1 sintético (como MockXmlProvider de packages/sunat) y una lectura mínima de UBL para
// «Subir XML». Solo para la demo: no valida contra XSD ni firma.
import { Money } from "@contapp/domain";
import type { FilaCompra, XmlDemo, XmlItem } from "../datos/tipos";
import { sumar } from "./dominio";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const CODIGO_AFECTACION: Record<XmlItem["afectacion"], string> = { Gravado: "10", Exonerado: "20", Inafecto: "30" };

export function generarUbl(f: FilaCompra, xml: XmlDemo, emisor: string, receptorRuc: string, receptor: string): string {
  const mon = xml.moneda;
  const lineas = xml.items
    .map(
      (it, i) => `  <cac:InvoiceLine>
    <cbc:ID>${i + 1}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="${esc(it.unidad)}">${it.cantidad}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="${mon}">${it.valor}</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="${mon}">${sumar([it.igv, it.isc, it.icbper])}</cbc:TaxAmount>
      <cac:TaxSubtotal>
        <cbc:TaxableAmount currencyID="${mon}">${it.valor}</cbc:TaxableAmount>
        <cbc:TaxAmount currencyID="${mon}">${it.igv}</cbc:TaxAmount>
        <cac:TaxCategory>
          <cbc:TaxExemptionReasonCode>${CODIGO_AFECTACION[it.afectacion]}</cbc:TaxExemptionReasonCode>
          <cac:TaxScheme><cbc:ID>${it.afectacion === "Gravado" ? "1000" : it.afectacion === "Exonerado" ? "9997" : "9998"}</cbc:ID></cac:TaxScheme>
        </cac:TaxCategory>
      </cac:TaxSubtotal>${
        it.isc !== "0.00"
          ? `
      <cac:TaxSubtotal>
        <cbc:TaxAmount currencyID="${mon}">${it.isc}</cbc:TaxAmount>
        <cac:TaxCategory><cac:TaxScheme><cbc:ID>2000</cbc:ID><cbc:Name>ISC</cbc:Name></cac:TaxScheme></cac:TaxCategory>
      </cac:TaxSubtotal>`
          : ""
      }${
        it.icbper !== "0.00"
          ? `
      <cac:TaxSubtotal>
        <cbc:TaxAmount currencyID="${mon}">${it.icbper}</cbc:TaxAmount>
        <cac:TaxCategory><cac:TaxScheme><cbc:ID>7152</cbc:ID><cbc:Name>ICBPER</cbc:Name></cac:TaxScheme></cac:TaxCategory>
      </cac:TaxSubtotal>`
          : ""
      }
    </cac:TaxTotal>
    <cac:Item><cbc:Description>${esc(it.descripcion)}</cbc:Description></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="${mon}">${it.precioUnitario}</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- XML SIMULADO por la demo de ContApp (MockXmlProvider). Datos ficticios: no es un comprobante real. -->
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:ID>${f.serie}-${f.numero}</cbc:ID>
  <cbc:IssueDate>${f.fecha}</cbc:IssueDate>
  <cbc:InvoiceTypeCode>${f.tipo}</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>${mon}</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty><cac:Party>
    <cac:PartyIdentification><cbc:ID schemeID="6">${f.proveedorRuc}</cbc:ID></cac:PartyIdentification>
    <cac:PartyLegalEntity><cbc:RegistrationName>${esc(emisor)}</cbc:RegistrationName></cac:PartyLegalEntity>
  </cac:Party></cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party>
    <cac:PartyIdentification><cbc:ID schemeID="6">${receptorRuc}</cbc:ID></cac:PartyIdentification>
    <cac:PartyLegalEntity><cbc:RegistrationName>${esc(receptor)}</cbc:RegistrationName></cac:PartyLegalEntity>
  </cac:Party></cac:AccountingCustomerParty>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${mon}">${sumar([xml.igv, xml.isc, xml.icbper])}</cbc:TaxAmount>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${mon}">${sumar([xml.gravado, xml.noGravado])}</cbc:LineExtensionAmount>
    <cbc:PayableAmount currencyID="${mon}">${xml.total}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
${lineas}
</Invoice>
`;
}

/** Lee un UBL 2.1 (de la demo o de fixtures/xml) y devuelve el resumen; null si no se puede. */
export function leerUbl(texto: string): { xml: XmlDemo; ruc: string | null; id: string | null } | null {
  const doc = new DOMParser().parseFromString(texto, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) return null;
  const hijos = (n: Element | Document, nombre: string) => [...n.getElementsByTagName("*")].filter((e) => e.localName === nombre);
  const directo = (n: Element, nombre: string) => [...n.children].find((e) => e.localName === nombre);
  const canon = (s: string | null | undefined) => {
    const t = (s ?? "0").trim();
    const [e, d = ""] = t.split(".");
    try {
      return Money.desde(`${e}.${d.padEnd(2, "0").slice(0, 2)}`, "PEN").toString();
    } catch {
      return "0.00";
    }
  };
  const lineas = hijos(doc, "InvoiceLine");
  if (lineas.length === 0) return null;
  const moneda = (hijos(doc, "DocumentCurrencyCode")[0]?.textContent?.trim() === "USD" ? "USD" : "PEN") as "PEN" | "USD";
  const items: XmlItem[] = lineas.map((l) => {
    const subtotales = hijos(l, "TaxSubtotal");
    let igv = "0.00",
      isc = "0.00",
      icbper = "0.00";
    let afectacion: XmlItem["afectacion"] = "Gravado";
    for (const s of subtotales) {
      const id = hijos(s, "TaxScheme")[0] ? hijos(hijos(s, "TaxScheme")[0]!, "ID")[0]?.textContent?.trim() : "";
      const monto = canon(directo(s, "TaxAmount")?.textContent);
      if (id === "1000") igv = monto;
      else if (id === "2000") isc = monto;
      else if (id === "7152") icbper = monto;
      else if (id === "9997") afectacion = "Exonerado";
      else if (id === "9998") afectacion = "Inafecto";
    }
    const cantidad = (directo(l, "InvoicedQuantity")?.textContent ?? "1").trim();
    return {
      descripcion: (hijos(l, "Description")[0]?.textContent ?? "Ítem").trim(),
      cantidad,
      unidad: directo(l, "InvoicedQuantity")?.getAttribute("unitCode") ?? "UND",
      precioUnitario: canon(hijos(l, "PriceAmount")[0]?.textContent),
      valor: canon(directo(l, "LineExtensionAmount")?.textContent),
      afectacion,
      igv,
      isc,
      icbper,
    };
  });
  const gravado = sumar(items.filter((i) => i.afectacion === "Gravado").map((i) => i.valor));
  const noGravado = sumar(items.filter((i) => i.afectacion !== "Gravado").map((i) => i.valor));
  const xml: XmlDemo = {
    moneda,
    items,
    gravado,
    noGravado,
    igv: sumar(items.map((i) => i.igv)),
    isc: sumar(items.map((i) => i.isc)),
    icbper: sumar(items.map((i) => i.icbper)),
    total: canon(hijos(doc, "PayableAmount")[0]?.textContent),
    subido: true,
  };
  const proveedor = hijos(doc, "AccountingSupplierParty")[0];
  const ruc = proveedor ? (hijos(proveedor, "ID")[0]?.textContent?.trim() ?? null) : null;
  const id = [...doc.documentElement.children].find((e) => e.localName === "ID")?.textContent?.trim() ?? null;
  return { xml, ruc, id };
}

// Spec 016 · T2. Ayudas de las pruebas del parser UBL y del dominio con XML: los cinco fixtures de
// `fixtures/xml/` (cargados con `?raw`: domain no hace IO ni siquiera en pruebas), una plantilla UBL 2.1 mínima
// para armar casos a medida y un `DetalleXml` literal para probar las reglas sin pasar por el parser.
//
// Contrato que fijan estas pruebas para `DetalleXml` (el plan deja los nombres abiertos; T8 los respeta):
//   { raiz, identidad: { tipo, serie, numero, emisor: { ruc, razonSocial }, receptor: { tipoDoc, numero } },
//     fecha, moneda, monedaUnica, totales: { gravado, igv, noGravado, isc, icbper, otros, total },
//     items: [{ descripcion, cantidad, unidad, precioUnitario, valor, afectacion, igv, isc, icbper }] }
// con todos los montos como cadenas decimales (nunca `number`).
import { codificar } from "../../src/texto/index";
import type { DetalleXml } from "../../src/ubl/index";
import sanJuanXml from "../../../../fixtures/xml/20700000011-01-F001-1040.xml?raw";
import mixtaXml from "../../../../fixtures/xml/20700000045-01-F001-2056.xml?raw";
import icbperXml from "../../../../fixtures/xml/20700000053-01-F001-3064.xml?raw";
import usdXml from "../../../../fixtures/xml/20700000061-01-F001-4062.xml?raw";
import zapatillaXml from "../../../../fixtures/xml/20700000070-01-F001-5070.xml?raw";

/** Los cinco fixtures de 009, por caso real. */
export const FIXTURES = {
  sanJuan: sanJuanXml,
  mixta: mixtaXml,
  icbper: icbperXml,
  usd: usdXml,
  zapatilla: zapatillaXml,
} as const;

export const RUC_CLIENTE = "20700000002";

/** Texto → bytes UTF-8 (sin `TextEncoder`, que domain no usa). */
export const utf8 = (texto: string): Uint8Array => codificar(texto, "utf8");

export function unir(...partes: readonly Uint8Array[]): Uint8Array {
  let largo = 0;
  for (const p of partes) largo += p.length;
  const salida = new Uint8Array(largo);
  let desde = 0;
  for (const p of partes) {
    salida.set(p, desde);
    desde += p.length;
  }
  return salida;
}

// ------------------------------------------------------------------ plantilla UBL 2.1
const NS = {
  Invoice: "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2",
  CreditNote: "urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2",
  DebitNote: "urn:oasis:names:specification:ubl:schema:xsd:DebitNote-2",
} as const;
const CANTIDAD = { Invoice: "InvoicedQuantity", CreditNote: "CreditedQuantity", DebitNote: "DebitedQuantity" } as const;

export type RaizUbl = keyof typeof NS;

/** `TaxSubtotal` de un esquema (1000, 2000, 7152, 9995…); `base` null = sin `TaxableAmount`. */
export function subtotal(esquema: string, base: string | null, monto: string, moneda = "PEN"): string {
  const imponible = base === null ? "" : `<cbc:TaxableAmount currencyID="${moneda}">${base}</cbc:TaxableAmount>`;
  return `<cac:TaxSubtotal>${imponible}<cbc:TaxAmount currencyID="${moneda}">${monto}</cbc:TaxAmount><cac:TaxCategory><cac:TaxScheme><cbc:ID>${esquema}</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>`;
}

export interface OpcionesLinea {
  readonly raiz?: RaizUbl;
  readonly n?: string;
  readonly descripcion?: string;
  readonly cantidad?: string;
  readonly unidad?: string;
  readonly precio?: string;
  readonly valor?: string;
  /** `TaxSubtotal` de la línea (ya armados con `subtotal`). */
  readonly subtotales?: readonly string[];
  readonly moneda?: string;
}

/** Una línea compacta (unos 300 bytes sin impuestos) para armar facturas de muchos ítems. */
export function linea(o: OpcionesLinea = {}): string {
  const raiz = o.raiz ?? "Invoice";
  const moneda = o.moneda ?? "PEN";
  const impuestos =
    o.subtotales === undefined ? "" : `<cac:TaxTotal>${o.subtotales.join("")}</cac:TaxTotal>`;
  return (
    `<cac:${raiz}Line><cbc:ID>${o.n ?? "1"}</cbc:ID>` +
    `<cbc:${CANTIDAD[raiz]} unitCode="${o.unidad ?? "NIU"}">${o.cantidad ?? "1"}</cbc:${CANTIDAD[raiz]}>` +
    `<cbc:LineExtensionAmount currencyID="${moneda}">${o.valor ?? "100.00"}</cbc:LineExtensionAmount>` +
    `${impuestos}<cac:Item><cbc:Description>${o.descripcion ?? "Producto de prueba"}</cbc:Description></cac:Item>` +
    `<cac:Price><cbc:PriceAmount currencyID="${moneda}">${o.precio ?? "100.00"}</cbc:PriceAmount></cac:Price></cac:${raiz}Line>`
  );
}

export interface OpcionesUbl {
  readonly raiz?: RaizUbl;
  /** `cbc:ID`, «SERIE-NUMERO». */
  readonly id?: string;
  /** Código de tipo (`InvoiceTypeCode`); solo se escribe en `Invoice`. */
  readonly tipo?: string;
  readonly fecha?: string;
  readonly moneda?: string;
  readonly emisor?: { readonly ruc: string; readonly razonSocial: string };
  readonly receptor?: { readonly tipoDoc: string; readonly numero: string };
  /** `TaxSubtotal` del `TaxTotal` del documento. Por defecto IGV 18 % sobre 100.00. */
  readonly subtotales?: readonly string[];
  /** `PayableAmount` y `TaxInclusiveAmount`: `null` = el elemento no se escribe. */
  readonly pagable?: string | null;
  readonly incluyeImpuestos?: string | null;
  readonly monedaTotales?: string;
  readonly lineas?: readonly string[];
  /** Texto antes de `cbc:ID` (p. ej. `UBLExtensions`), después de la raíz y la declaración. */
  readonly extensiones?: string;
  /** Texto justo antes del cierre de la raíz. */
  readonly final?: string;
  /** Declaración `<?xml …?>`; `null` = sin declaración. */
  readonly declaracion?: string | null;
}

/** UBL 2.1 mínimo y válido con los prefijos habituales `cbc:` y `cac:`. */
export function ubl(o: OpcionesUbl = {}): string {
  const raiz = o.raiz ?? "Invoice";
  const moneda = o.moneda ?? "PEN";
  const emisor = o.emisor ?? { ruc: "20700000045", razonSocial: "PRUEBA PROVEEDOR S.A.C." };
  const receptor = o.receptor ?? { tipoDoc: "6", numero: RUC_CLIENTE };
  const subtotales = o.subtotales ?? [subtotal("1000", "100.00", "18.00", moneda)];
  const monedaTotales = o.monedaTotales ?? moneda;
  const pagable = o.pagable === undefined ? "118.00" : o.pagable;
  const incluye = o.incluyeImpuestos === undefined ? "118.00" : o.incluyeImpuestos;
  const declaracion =
    o.declaracion === undefined ? '<?xml version="1.0" encoding="UTF-8"?>\n' : o.declaracion === null ? "" : o.declaracion;
  const codigoTipo = raiz === "Invoice" ? `<cbc:InvoiceTypeCode listID="0101">${o.tipo ?? "01"}</cbc:InvoiceTypeCode>` : "";
  const totales =
    (incluye === null ? "" : `<cbc:TaxInclusiveAmount currencyID="${monedaTotales}">${incluye}</cbc:TaxInclusiveAmount>`) +
    (pagable === null ? "" : `<cbc:PayableAmount currencyID="${monedaTotales}">${pagable}</cbc:PayableAmount>`);
  const lineas = o.lineas ?? [linea({ raiz, moneda })];
  return (
    `${declaracion}<${raiz} xmlns="${NS[raiz]}" ` +
    `xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" ` +
    `xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">` +
    `${o.extensiones ?? ""}<cbc:UBLVersionID>2.1</cbc:UBLVersionID><cbc:ID>${o.id ?? "F001-2056"}</cbc:ID>` +
    `<cbc:IssueDate>${o.fecha ?? "2026-10-05"}</cbc:IssueDate>${codigoTipo}` +
    `<cbc:DocumentCurrencyCode>${moneda}</cbc:DocumentCurrencyCode>` +
    `<cac:AccountingSupplierParty><cac:Party><cac:PartyIdentification><cbc:ID schemeID="6">${emisor.ruc}</cbc:ID></cac:PartyIdentification>` +
    `<cac:PartyLegalEntity><cbc:RegistrationName>${emisor.razonSocial}</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty>` +
    `<cac:AccountingCustomerParty><cac:Party><cac:PartyIdentification><cbc:ID schemeID="${receptor.tipoDoc}">${receptor.numero}</cbc:ID></cac:PartyIdentification>` +
    `<cac:PartyLegalEntity><cbc:RegistrationName>PRUEBA CONTRIBUYENTE S.A.C.</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingCustomerParty>` +
    `<cac:TaxTotal><cbc:TaxAmount currencyID="${moneda}">0.00</cbc:TaxAmount>${subtotales.join("")}</cac:TaxTotal>` +
    `<cac:LegalMonetaryTotal>${totales}</cac:LegalMonetaryTotal>` +
    `${lineas.join("")}${o.final ?? ""}</${raiz}>\n`
  );
}

/** El UBL sintético de 009 (`generarUblSintetico`), con ISC si `isc` no es cero: misma forma, receptor «-». */
export function ublSintetico(o: {
  readonly base: string;
  readonly igv: string;
  readonly isc: string;
  readonly total: string;
  readonly moneda?: "PEN" | "USD";
}): string {
  const moneda = o.moneda ?? "PEN";
  const conIsc = o.isc !== "0.00";
  const subtotales = [subtotal("1000", o.base, o.igv, moneda), ...(conIsc ? [subtotal("2000", o.base, o.isc, moneda)] : [])];
  return ubl({
    moneda,
    id: "F001-1040",
    emisor: { ruc: "20100070970", razonSocial: "PRUEBA EMISOR SINTETICO" },
    receptor: { tipoDoc: "0", numero: "-" },
    subtotales,
    pagable: o.total,
    incluyeImpuestos: o.total,
    lineas: [linea({ moneda, valor: o.base, precio: o.base, descripcion: "Producto sintético de prueba (PRUEBA)" })],
  });
}

// ------------------------------------------------------------------ DetalleXml literal
/** `DetalleXml` de F001-2056 (CA-3); `parcial` pisa campos de primer nivel. */
export function detalleMixta(parcial: Partial<DetalleXml> = {}): DetalleXml {
  return {
    raiz: "Invoice",
    identidad: {
      tipo: "01",
      serie: "F001",
      numero: "2056",
      emisor: { ruc: "20700000045", razonSocial: "PRUEBA PROVEEDOR MIXTO S.A.C." },
      receptor: { tipoDoc: "6", numero: RUC_CLIENTE },
    },
    fecha: "2026-10-05",
    moneda: "PEN",
    monedaUnica: true,
    totales: { gravado: "8.97", igv: "1.61", noGravado: "12.51", isc: "0.00", icbper: "0.00", otros: "0.00", total: "23.09" },
    items: [
      { descripcion: "Producto gravado de prueba (PRUEBA)", cantidad: "1", unidad: "NIU", precioUnitario: "8.97", valor: "8.97", afectacion: "gravado", igv: "1.61", isc: "0.00", icbper: "0.00" },
      { descripcion: "Producto exonerado de prueba (PRUEBA)", cantidad: "1", unidad: "NIU", precioUnitario: "12.51", valor: "12.51", afectacion: "exonerado", igv: "0.00", isc: "0.00", icbper: "0.00" },
    ],
    ...parcial,
  } as DetalleXml;
}

/** `DetalleXml` de F001-1040 (San Juan, CA-4): valor 0.00 e ISC 770.00. */
export function detalleSanJuan(parcial: Partial<DetalleXml> = {}): DetalleXml {
  return {
    raiz: "Invoice",
    identidad: {
      tipo: "01",
      serie: "F001",
      numero: "1040",
      emisor: { ruc: "20700000011", razonSocial: "PRUEBA PROVEEDOR ISC S.A.C." },
      receptor: { tipoDoc: "6", numero: RUC_CLIENTE },
    },
    fecha: "2026-10-02",
    moneda: "PEN",
    monedaUnica: true,
    totales: { gravado: "0.00", igv: "0.00", noGravado: "0.00", isc: "770.00", icbper: "0.00", otros: "0.00", total: "770.00" },
    items: [
      { descripcion: "Producto de prueba con ISC (PRUEBA)", cantidad: "1", unidad: "NIU", precioUnitario: "0.00", valor: "0.00", afectacion: "gravado", igv: "0.00", isc: "770.00", icbper: "0.00" },
    ],
    ...parcial,
  } as DetalleXml;
}

// Spec 016 (D-1, D-2, plan «Contratos: Dominio»): lo que el parser UBL extrae de un comprobante. Puro: sin IO.
// Todos los montos son cadenas decimales con 2 decimales (tras `redondearSunat`), nunca `number`; las notas de crédito
// salen en negativo (010 D6). El precio unitario y la cantidad se guardan exactos, como texto (solo se muestran).
import type { Moneda } from "../dinero/index";

export type RaizUbl = "Invoice" | "CreditNote" | "DebitNote";

export type CodigoUbl = "xml_invalido" | "xml_incompleto";

/** Afectación de una línea según el `TaxScheme/ID` de sus impuestos (catálogo 05 de SUNAT). */
export type AfectacionXml = "gravado" | "exonerado" | "inafecto" | "exportacion" | "gratuito" | "otro";

export interface ItemXml {
  /** `Item/Description`, recortada a 500 caracteres; texto no confiable. */
  readonly descripcion: string;
  /** Texto exacto. */
  readonly cantidad: string;
  /** `unitCode` de la cantidad ("" si no viene). */
  readonly unidad: string;
  /** `Price/PriceAmount` exacto, sin redondear. */
  readonly precioUnitario: string;
  /** `LineExtensionAmount`. */
  readonly valor: string;
  readonly afectacion: AfectacionXml;
  readonly igv: string;
  readonly isc: string;
  readonly icbper: string;
}

export interface TotalesXml {
  readonly gravado: string;
  readonly igv: string;
  /** 9997 (exonerado) + 9998 (inafecto). */
  readonly noGravado: string;
  readonly isc: string;
  readonly icbper: string;
  /** 9999: solo se muestra. */
  readonly otros: string;
  readonly total: string;
}

export interface IdentidadXml {
  /** 01, 03, 07 u 08. */
  readonly tipo: string;
  /** En mayúsculas. */
  readonly serie: string;
  /** Sin ceros a la izquierda. */
  readonly numero: string;
  readonly emisor: { readonly ruc: string; readonly razonSocial: string };
  readonly receptor: { readonly tipoDoc: string; readonly numero: string };
}

export interface DetalleXml {
  readonly raiz: RaizUbl;
  readonly identidad: IdentidadXml;
  /** `IssueDate`, AAAA-MM-DD. */
  readonly fecha: string;
  /** `DocumentCurrencyCode`. */
  readonly moneda: Moneda;
  /** `false` si algún `currencyID` leído no es la moneda del documento (011 lo trata como `XML_MONEDA`). */
  readonly monedaUnica: boolean;
  readonly totales: TotalesXml;
  readonly items: readonly ItemXml[];
}

const MENSAJES: Readonly<Record<CodigoUbl, string>> = {
  xml_invalido: "El archivo no es un comprobante XML válido.",
  xml_incompleto: "Al comprobante XML le faltan datos obligatorios.",
};

/** Error del parser: código estable y mensaje fijo; nunca lleva el contenido del XML ni una causa. */
export class UblError extends Error {
  readonly codigo: CodigoUbl;

  constructor(codigo: CodigoUbl) {
    super(MENSAJES[codigo]);
    this.name = "UblError";
    this.codigo = codigo;
  }
}

export const invalido = (): never => {
  throw new UblError("xml_invalido");
};

export const incompleto = (): never => {
  throw new UblError("xml_incompleto");
};

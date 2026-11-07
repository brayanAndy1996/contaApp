// Preparación de las filas de ventas para el complemento (spec 013, D3, D16). La comparten la descarga del worker y la
// importación del backend: así lo recibido se normaliza igual que `leerExistentes` devuelve lo guardado y no hay dos
// copias que se desvíen. Sin dominio: quien llama valida la fila (`validarFilaVenta`) y calcula la clave.
//
// Comparación (D16): fecha, moneda, tipo de cambio, tipo y número de documento y los 8 montos; nunca la razón social.
// Los campos se llaman como los de `FilaVentaSire`. Montos con 2 decimales (ya los deja `validarFilaVenta`), tipo de
// cambio con los 3 de NUMERIC(7,3) y cadena vacía si falta, y tipo de documento «0» si falta (es lo que se guarda).
import type { FilaComplementable, ExistenteComplementable } from "../propuestas/complemento";
import type { ExistenteVenta, MonedaVenta, VentaNueva } from "./tipos";

/** Tipo de documento de la contraparte cuando no se informa. */
export const TIPO_DOC_AUSENTE = "0";
const DECIMALES_TIPO_CAMBIO = 3;

/** «3.3» → «3.300». La gramática del dominio ya limita a 3 decimales, así que solo se completan ceros. */
export function tipoCambioConEscala(tc: string): string {
  const [entera = "", fraccion = ""] = tc.split(".");
  return `${entera}.${fraccion.padEnd(DECIMALES_TIPO_CAMBIO, "0")}`;
}

/** Forma de una fila que `validarFilaVenta` dio por buena (`FilaVentaValida`), sin importar el dominio. */
export interface FilaVentaLegible {
  readonly tipo: string;
  readonly serie: string;
  readonly numero: string;
  readonly tipoDocContraparte?: string;
  readonly docContraparte: string;
  readonly fechaEmision: string;
  readonly moneda: MonedaVenta;
  readonly tipoCambio?: string;
  readonly baseGravada: string;
  readonly igv: string;
  readonly exonerada: string;
  readonly inafecta: string;
  readonly isc: string;
  readonly icbper: string;
  readonly otros: string;
  readonly total: string;
}

/** Una fila legible de ventas, con su `clave` (`claveNormalizada`), lista para comparar y guardar. */
export function prepararFilaVenta(f: FilaVentaLegible, clave: string): FilaComplementable<VentaNueva> {
  const tipoCambio = f.tipoCambio === undefined ? null : tipoCambioConEscala(f.tipoCambio);
  const tipoDocContraparte = f.tipoDocContraparte ?? TIPO_DOC_AUSENTE;
  return {
    clave,
    campos: {
      fechaEmision: f.fechaEmision,
      moneda: f.moneda,
      tipoCambio: tipoCambio ?? "",
      tipoDocContraparte,
      docContraparte: f.docContraparte,
      baseGravada: f.baseGravada,
      igv: f.igv,
      exonerada: f.exonerada,
      inafecta: f.inafecta,
      isc: f.isc,
      icbper: f.icbper,
      otros: f.otros,
      total: f.total,
    },
    datos: {
      clave,
      tipo: f.tipo,
      serie: f.serie,
      numero: f.numero,
      fecha: f.fechaEmision,
      tipoDocContraparte,
      docContraparte: f.docContraparte,
      moneda: f.moneda,
      tipoCambio,
      baseGravada: f.baseGravada,
      igv: f.igv,
      exonerada: f.exonerada,
      inafecta: f.inafecta,
      isc: f.isc,
      icbper: f.icbper,
      otros: f.otros,
      total: f.total,
    },
  };
}

/** `leerExistentes` nombra la fecha `fecha` (columna); la comparación usa el nombre de `FilaVentaSire`. */
export function existenteComplementable(e: ExistenteVenta): ExistenteComplementable {
  const { fecha, ...resto } = e.campos;
  return { clave: e.clave, origen: e.origen, campos: { fechaEmision: fecha as string, ...resto } };
}

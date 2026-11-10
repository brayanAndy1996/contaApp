// Contratos públicos de prevalidacion/ (plan 012, Contratos). Montos siempre Money/MontosComprobante
// de 010; el resultado de prevalidar sale congelado.
import type { Destino, MontosComprobante } from "../comprobante/index";
import type { Money } from "../dinero/index";
import type { CabeceraTxt } from "../formatos/tipos";
import type { ColumnaVenta } from "../ventas/columnas";
import type { RegistroFormatos } from "../formatos/registro";
import type { Entero } from "../texto/entero";
import type { ContextoReglas, DocProveedor, Hallazgo, IdComprobante, ResumenXml } from "../reglas/index";

export type EstadoFila = "original" | "modificada" | "agregada" | "excluida";

/** Fila del periodo a generar (D3). La moneda es la de `montos`. */
export interface FilaReemplazo {
  /** ^[A-Za-z0-9_-]{1,64}$, único en la llamada. */
  readonly id: string;
  readonly estado: EstadoFila;
  readonly comprobante: IdComprobante;
  readonly proveedor: DocProveedor & { readonly razonSocial?: string };
  /** AAAA-MM-DD. */
  readonly fechaEmision: string;
  readonly montos: MontosComprobante;
  /** Obligatorio si la fila es USD; `null` si es PEN. */
  readonly tipoCambio: string | null;
  /** Solo en filas PEN que vienen de un comprobante en USD. */
  readonly origenUsd: { readonly montos: MontosComprobante; readonly tipoCambio: string } | null;
  readonly xml?: ResumenXml;
}

export type CodigoError =
  | "CAMPO_OBLIGATORIO"
  | "LONGITUD"
  | "PATRON"
  | "CARACTER_NO_PERMITIDO"
  | "RUC_INVALIDO"
  | "FECHA_INVALIDA"
  | "FECHA_POSTERIOR_AL_PERIODO"
  | "CUADRE"
  | "IGV"
  | "USD_SIN_TC"
  | "TC_INVALIDO"
  | "CONVERSION_USD"
  | "DUPLICADO"
  | "SIN_FILAS";

export interface ErrorPrevalidacion {
  readonly filaId: string | null;
  readonly codigo: CodigoError;
  readonly campo: string | null;
  readonly destino: Destino | null;
  readonly explicacion: string;
  /** Solo en CUADRE: total − Σ componentes, en la moneda de la fila. */
  readonly diferencia: Money | null;
  /** Hallazgo de 011 (R-MIX en IGV, R-RED en CUADRE o CONVERSION_USD) si se pasaron `reglas`. */
  readonly sugerencia: Hallazgo | null;
}

export type CodigoAvisoPrevalidacion = "R-ISC" | "R-NEW" | "R-GP";

export interface AvisoPrevalidacion {
  readonly filaId: string;
  readonly codigo: CodigoAvisoPrevalidacion;
  readonly explicacion: string;
  readonly hallazgo: Hallazgo;
}

export interface ResultadoPrevalidacion {
  readonly apto: boolean;
  readonly errores: readonly ErrorPrevalidacion[];
  readonly avisos: readonly AvisoPrevalidacion[];
  readonly formato: { readonly id: string; readonly version: string; readonly oficial: boolean };
}

export interface ContextoPrevalidacion {
  readonly cabecera: CabeceraTxt;
  readonly reglas?: ContextoReglas;
  readonly registro?: RegistroFormatos;
}

/** Resumen de cambios entre el original y el vigente (D12, CA-8). Montos en PEN. */
export interface ResumenCambios {
  readonly modificadas: Entero;
  readonly excluidas: Entero;
  readonly agregadas: Entero;
  /** Σ IGV de las vigentes no excluidas − Σ IGV de las originales, por destino; total = DG + DGNG + DNG. */
  readonly impactoIgv: { readonly DG: Money; readonly DGNG: Money; readonly DNG: Money; readonly total: Money };
  /** Ids de las filas USD que no se pudieron convertir a PEN (sin repetir, por unidades de código). */
  readonly filasSinConvertir: readonly string[];
}

// ---------------------------------------------------------------- ventas (spec 012b, D12; plan, Contratos: Dominio)
export type EstadoFilaVenta = "original" | "agregada" | "excluida";

/** Fila de ventas del periodo a generar. La moneda es la de sus `montos` (las ocho columnas, todas en la misma). */
export interface FilaReemplazoVenta {
  /** ^[A-Za-z0-9_-]{1,64}$, único en la llamada. */
  readonly id: string;
  readonly estado: EstadoFilaVenta;
  readonly comprobante: IdComprobante;
  /** Sin `tipo` en el consumidor final (numero «-»). */
  readonly contraparte: { readonly tipo?: string; readonly numero: string };
  /** AAAA-MM-DD. */
  readonly fechaEmision: string;
  readonly montos: Readonly<Record<ColumnaVenta, Money>>;
  /** Obligatorio si la fila es USD; `null` si es PEN. */
  readonly tipoCambio: string | null;
}

/** Contexto de prevalidar con ventas: sin `reglas` (pasarlas lanza). */
export interface ContextoPrevalidacionVentas {
  readonly cabecera: CabeceraTxt;
  readonly registro?: RegistroFormatos;
}

/** Resumen de cambios de ventas: no hay modificadas; el impacto es solo el IGV total, en PEN. */
export interface ResumenCambiosVentas {
  readonly modificadas: 0;
  readonly excluidas: Entero;
  readonly agregadas: Entero;
  readonly impactoIgv: { readonly total: Money };
  readonly filasSinConvertir: readonly string[];
}

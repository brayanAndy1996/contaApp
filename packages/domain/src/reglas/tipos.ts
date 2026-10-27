// Contratos públicos de reglas/ (plan 011, Contratos). Montos siempre Money/MontosComprobante
// de 010; los resultados de evaluarReglas salen congelados.
import type { ColumnaCompra, Destino, MontosComprobante } from "../comprobante/index";
import type { Money, Moneda, TipoCambio } from "../dinero/index";
import type { DiccionarioGlosas } from "../texto/index";

export type CodigoRegla = "R-ISC" | "R-MIX" | "R-RED" | "R-NEW" | "R-GP";

/** Orden de salida de los hallazgos de una misma fila. */
export const ORDEN_REGLAS: readonly CodigoRegla[] = Object.freeze([
  "R-ISC",
  "R-MIX",
  "R-RED",
  "R-NEW",
  "R-GP",
] as const);

/** tipo ^[0-9A-Z]$; numero ^[0-9A-Z-]{1,15}$ tras quitar espacios y pasar a mayúsculas. */
export interface DocProveedor {
  readonly tipo: string;
  readonly numero: string;
}

/** ^[0-9]{2}$ · ^[0-9A-Z]{1,4}$ · ^[0-9]{1,8}$ (los ceros a la izquierda no cuentan). */
export interface IdComprobante {
  readonly tipo: string;
  readonly serie: string;
  readonly numero: string;
}

/** Resumen del XML del comprobante (lo produce 016; mock en 009). */
export interface ResumenXml {
  readonly proveedor: DocProveedor;
  readonly comprobante: IdComprobante;
  readonly moneda: Moneda;
  readonly gravado: Money;
  readonly igv: Money;
  /** exonerado + inafecto */
  readonly noGravado: Money;
  readonly isc: Money;
  readonly icbper: Money;
  readonly total: Money;
  /** Descripción de cada ítem. */
  readonly glosas: readonly string[];
}

export interface OrigenUsd {
  /** Montos en USD. */
  readonly montos: MontosComprobante;
  readonly tipoCambio: TipoCambio;
}

export interface FilaEvaluable {
  /** ^[A-Za-z0-9_-]{1,64}$, único en la llamada. */
  readonly id: string;
  readonly proveedor: DocProveedor;
  readonly comprobante: IdComprobante;
  readonly montos: MontosComprobante;
  /** Solo si `montos` está en PEN. */
  readonly origenUsd?: OrigenUsd;
  readonly xml?: ResumenXml;
}

export interface ContextoReglas {
  /** Historial del cliente (sin el periodo actual). */
  readonly proveedoresConocidos: readonly DocProveedor[];
  /** Marca "emisor de ISC" (R1: dato del llamador). */
  readonly proveedoresIsc: readonly DocProveedor[];
  readonly diccionario: DiccionarioGlosas;
}

/** Columnas (y total) con su monto: lecturas de un hallazgo y valores de `ajustar`. */
export type MontosParciales = Readonly<Partial<Record<ColumnaCompra | "total", Money>>>;

export interface SugerenciaMover {
  tipo: "mover";
  origen: ColumnaCompra;
  destino: ColumnaCompra;
  monto: Money;
}
/** R-MIX: gravado en `columnaBi`; el resto va a noGravado. Siempre min ≤ max numéricamente. */
export interface SugerenciaSeparar {
  tipo: "separar";
  columnaBi: ColumnaCompra;
  min: Money;
  max: Money;
  estimado: Money;
  exacto: Money | null;
}
export interface SugerenciaAjustar {
  tipo: "ajustar";
  valores: MontosParciales;
}
export interface SugerenciaClasificar {
  tipo: "clasificar";
}
export interface SugerenciaExcluir {
  tipo: "excluir";
  palabra: string;
  categoria: string;
}
export type Sugerencia =
  | SugerenciaMover
  | SugerenciaSeparar
  | SugerenciaAjustar
  | SugerenciaClasificar
  | SugerenciaExcluir;

export type DatoRequerido = "gravado" | "destino";

export interface Hallazgo {
  readonly filaId: string;
  readonly regla: CodigoRegla;
  readonly destino: Destino | null;
  /** Catálogo fijo de explicaciones.ts; nunca texto del XML salvo la palabra del diccionario. */
  readonly explicacion: string;
  /** null = solo aviso (rango vacío, descuadre grande, XML sin ISC…). */
  readonly sugerencia: Sugerencia | null;
  /** false solo si la sugerencia la respalda el XML. */
  readonly requiereConfirmacion: boolean;
  /** Lo que aplicar necesita del contador. */
  readonly dato: DatoRequerido | null;
  /** Columnas leídas, para detectar obsolescencia. */
  readonly lecturas: MontosParciales;
}

export type CodigoAviso = "XML_AJENO" | "XML_MONEDA";

export interface Aviso {
  readonly filaId: string;
  readonly codigo: CodigoAviso;
  readonly explicacion: string;
}

export type Confirmacion = { gravado: Money } | { destino: Destino };

export interface ResultadoEvaluacion {
  readonly hallazgos: readonly Hallazgo[];
  readonly avisos: readonly Aviso[];
}

export interface ResultadoAplicar {
  readonly montos: MontosComprobante;
  readonly excluir: boolean;
}

export interface EntradaMasiva {
  montos: MontosComprobante;
  hallazgo: Hallazgo;
  confirmacion?: Confirmacion;
}

export interface ResultadoMasivo {
  readonly aplicadas: readonly { filaId: string; montos: MontosComprobante; excluir: boolean }[];
  readonly rechazadas: readonly { filaId: string; regla: CodigoRegla; codigo: string }[];
}

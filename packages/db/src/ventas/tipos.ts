// Tipos de los repositorios de ventas (spec 013). Los montos y el tipo de cambio son CADENAS decimales ("118.00", "3.456"),
// nunca `number` (CLAUDE.md: Money/decimal.js y NUMERIC(14,2)); la fecha, "AAAA-MM-DD"; las marcas de tiempo, Date.

export type MonedaVenta = "PEN" | "USD";
export type OrigenVenta = "sire" | "manual";

/** Una venta lista para guardar (ya validada y con su clave normalizada, D17). */
export interface VentaNueva {
  clave: string;
  tipo: string;
  serie: string;
  numero: string;
  fecha: string;
  tipoDocContraparte: string;
  docContraparte: string;
  moneda: MonedaVenta;
  tipoCambio: string | null;
  baseGravada: string;
  igv: string;
  exonerada: string;
  inafecta: string;
  isc: string;
  icbper: string;
  otros: string;
  total: string;
}

export type VentaFila = VentaNueva & {
  id: string;
  clienteId: string;
  periodo: string;
  propuestaId: string | null;
  origen: OrigenVenta;
  /** Entero si `numero` tiene de 1 a 8 dígitos; `null` si no es evaluable. */
  numeroN: number | null;
  creadaPor: string | null;
  creadaEn: Date;
};

/** Contexto de una inserción de filas del SIRE o de una importación. */
export interface ContextoInsercionVentas {
  clienteId: string;
  periodo: string;
  propuestaId: string;
}

/**
 * Lo ya guardado de un comprobante, para `planificarComplemento` (D16). `campos` lleva fecha, moneda, tipoCambio,
 * tipoDocContraparte, docContraparte y los 8 montos como cadenas (sin razón social). Un tipo de cambio ausente se
 * representa con la cadena vacía.
 */
export interface ExistenteVenta {
  clave: string;
  origen: OrigenVenta;
  campos: Record<string, string>;
}

export interface FiltrosVentas {
  /** Desde 1. */
  pagina: number;
  tamano: 10 | 25 | 50 | "todas";
  q?: string;
  tipo?: string;
  serie?: string;
  /** Cadenas decimales comparadas como NUMERIC contra el total de la venta. */
  min?: string;
  max?: string;
}

export interface PaginaVentas {
  filas: VentaFila[];
  /** Filas que cumplen los filtros (no las de la página). */
  total: number;
  avisos: "todas_limitada"[];
}

export interface DatosJustificar {
  clienteId: string;
  periodo: string;
  tipo: string;
  serie: string;
  desde: number;
  hasta: number;
  comentario: string;
  usuarioId: string;
}

export interface Justificado {
  id: string;
  tipo: string;
  serie: string;
  desde: number;
  hasta: number;
  comentario: string;
  usuarioId: string;
  creadaEn: Date;
  revertidoPor: string | null;
  revertidoEn: Date | null;
}

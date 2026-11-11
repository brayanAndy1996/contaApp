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
  /** Spec 012b (D12): la exclusión vigente de la venta; `null` si nunca se excluyó o se restauró. */
  exclusion: ExclusionLeida | null;
};

/** La exclusión vigente de una venta, como la lleva `VentaFila` (sin el motivo en logs ni errores). */
export interface ExclusionLeida {
  motivo: string;
  por: string;
  en: Date;
}

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

// Spec 012b (P-1, P-9): estado del periodo de ventas, igual al de compras (014). Sin fila equivale a `abierto`.
export type EstadoPeriodoVentas = "abierto" | "revisado" | "generado";

export interface EstadoPeriodoVenta {
  estado: EstadoPeriodoVentas;
  marcadoPor: string | null;
  marcadoEn: Date | null;
}

// Spec 012b (P-8, D12): exclusión de una venta del SIRE con error.
export interface DatosExcluirVenta {
  clienteId: string;
  periodo: string;
  ventaId: string;
  /** De 1 a 200 caracteres (CHECK de la tabla). */
  motivo: string;
  usuarioId: string;
}

/** Una exclusión vigente (las cerradas no se devuelven). */
export interface ExclusionVenta {
  id: string;
  ventaId: string;
  motivo: string;
  excluidaPor: string;
  excluidaEn: Date;
  restauradaPor: null;
  restauradaEn: null;
}

/** Una venta excluida, para la lista del previo (comprobante y motivo). */
export interface ExcluidaVenta {
  ventaId: string;
  tipo: string;
  serie: string;
  numero: string;
  motivo: string;
}

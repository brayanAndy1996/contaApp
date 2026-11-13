// Tipos del repositorio de reglas aprendidas (spec 021). Solo cadenas, booleanos, enteros y fechas: `packages/db` no depende de
// `packages/domain`. Los montos viajan como cadenas NUMERIC exactas (`MontosCompra`), nunca como doble precisión.

export type DestinoRegla = "DG" | "DGNG" | "DNG";

/** Una regla aprendida viva, con la razón social más reciente del proveedor en el cliente y los contadores de P-4. */
export interface ReglaFila {
  id: string;
  clienteId: string;
  docTipo: string;
  docNumero: string;
  destino: DestinoRegla;
  activa: boolean;
  version: number;
  /** AAAAMM. */
  periodoAprendido: string;
  creadaPor: string;
  creadaEn: Date;
  actualizadaEn: Date;
  /** De la compra más reciente del proveedor en el cliente; `null` si no hay ninguna. */
  razonSocial: string | null;
  /** Filas con versión `historial` de esta regla. */
  aplicada: number;
  /** Aplicaciones que seguían en el destino al revisar su periodo. */
  aceptada: number;
}

/** Códigos de rechazo del repositorio; el backend los traduce a HTTP (404, 409 y 422). */
export type CodigoRegla = "regla_cambiada" | "proveedores_distintos" | "periodos_distintos" | "no_encontrada";

export interface EntradaRecordar {
  clienteId: string;
  compraIds: readonly string[];
  destino: DestinoRegla;
  /** `null` crea la regla; un número actualiza (y reactiva) la viva si su versión coincide. */
  versionBase: number | null;
  usuarioId: string;
}

export interface EntradaEditar {
  clienteId: string;
  reglaId: string;
  versionBase: number;
  destino?: DestinoRegla;
  activa?: boolean;
  usuarioId: string;
}

export interface EntradaEliminar {
  clienteId: string;
  reglaId: string;
  versionBase: number;
  usuarioId: string;
}

export interface LecturaMotor {
  /** Solo las filas guardadas: sin fila, la regla está encendida. */
  filas: { codigo: string; activa: boolean }[];
  /** Sin fila de configuración, el aporte está encendido. */
  aportarCatalogo: boolean;
}

/** Lo que devuelve `reglas_historial_vigentes` para la descarga. */
export interface ReglaVigente {
  reglaId: string;
  docTipo: string;
  docNumero: string;
  destino: DestinoRegla;
  version: number;
}

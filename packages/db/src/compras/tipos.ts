// Tipos estructurales de los repositorios de compras (spec 014). `packages/db` no depende de `packages/domain`: lo que el
// dominio calcula (reglas, edición, mapeo a `FilaReemplazo`) entra como función inyectada y estos tipos son solo cadenas,
// booleanos y enteros. Todo monto y tipo de cambio viaja como cadena NUMERIC exacta; nunca como doble precisión.

export const COLUMNAS_MONTO = [
  "biDg",
  "igvDg",
  "biDgng",
  "igvDgng",
  "biDng",
  "igvDng",
  "noGravado",
  "isc",
  "icbper",
  "otrosTributos",
] as const;
export type ColumnaMontoCompra = (typeof COLUMNAS_MONTO)[number];

/** Las 10 columnas de monto de 010 y el total, todas como cadenas con la escala de NUMERIC(14,2). */
export type MontosCompra = Record<ColumnaMontoCompra | "total", string>;

/** Lo que cambia en cada versión de una compra. */
export interface DatosVersion {
  montos: MontosCompra;
  excluida: boolean;
  motivo: string | null;
  clasificada: boolean;
}

/** Lo que identifica a una compra y no cambia (el trigger de identidad de 0032 lo garantiza). */
export interface IdentidadCompra {
  clave: string;
  tipoDoc: string;
  serie: string;
  numero: string;
  docTipo: string;
  docNumero: string;
  razonSocial: string | null;
  /** AAAA-MM-DD. */
  fecha: string;
  moneda: "PEN" | "USD";
  /** Hasta 3 decimales; `null` en PEN. */
  tipoCambio: string | null;
}

/** Una compra de un periodo para insertar (descarga o alta manual). */
export type CompraNueva = IdentidadCompra & { montos: MontosCompra };

/** Compra con su identidad y los datos de una versión (la vigente, salvo que se lea la 1). */
export interface CompraLeida extends IdentidadCompra {
  id: string;
  clienteId: string;
  periodo: string;
  origen: "sire" | "agregada";
  propuestaId: string | null;
  /** `n` de la versión que traen `montos`, `excluida`, `motivo` y `clasificada`. */
  version: number;
  excluida: boolean;
  motivo: string | null;
  clasificada: boolean;
  montos: MontosCompra;
}

export interface VersionFila extends DatosVersion {
  id: string;
  compraId: string;
  n: number;
  accion: string;
  operacionId: string | null;
  usuarioId: string | null;
  creadaEn: Date;
}

/** Hallazgo que devuelve `evaluar` para una versión (se guarda con `version_n` = la versión evaluada). */
export interface HallazgoNuevo {
  regla: string;
  sugerencia: unknown;
  lecturas: Record<string, string>;
  requiereConfirmacion: boolean;
}

/** Origen de un XML guardado (016 D-4): el mock entrega `simulado`, el proveedor real `real` y el usuario `subido`. */
export type OrigenDocumentoXml = "simulado" | "real" | "subido";

/**
 * El XML vigente del comprobante tal como lo recibe `evaluar` (016): el `detalle` (`DetalleXml` del dominio) viaja opaco, sin
 * ruta, hash ni autor. Lo lee `packages/db` dentro de la transacción, después de bloquear la fila.
 */
export interface XmlParaEvaluar {
  origen: OrigenDocumentoXml;
  detalle: unknown;
}

/** La fila que recibe `evaluar` (y `transformar`): la compra con su versión más el XML vigente o `null` sin XML (016). */
export type CompraConXml = CompraLeida & { xml: XmlParaEvaluar | null };

/** Re-evalúa las reglas de una fila con la versión nueva ya escrita (la inyecta el backend o el worker). */
export type Evaluar = (
  fila: CompraConXml,
) => Promise<HallazgoNuevo[]> | HallazgoNuevo[];

export type ResultadoTransformar = DatosVersion | { rechazo: string };

/**
 * Calcula los datos de la versión nueva a partir de la vigente (la inyecta el backend: edición, destino, sugerencia). Recibe la
 * fila con su XML vigente (016): aceptar una sugerencia re-evalúa con el mismo entorno que la evaluó.
 */
export type Transformar = (
  actual: CompraConXml,
  parametros: unknown,
) => Promise<ResultadoTransformar> | ResultadoTransformar;

export type EstadoPeriodoCompras = "abierto" | "revisado" | "generado";

export interface EstadoPeriodo {
  estado: EstadoPeriodoCompras;
  marcadoPor: string | null;
  marcadoEn: Date | null;
}

/** Lo que `leerExistentesCompras` entrega al complemento de 013. */
export interface ExistenteCompra {
  clave: string;
  /** `agregada` se informa como `manual` (013, punto 8). */
  origen: "sire" | "manual";
  campos: Record<string, string>;
}

export interface ProveedorConocido {
  tipo: string;
  numero: string;
}

export interface ResultadoAccion {
  operacionId: string;
  version: VersionFila;
}

export interface ResultadoMasiva {
  operacionId: string | null;
  aplicadas: number;
  rechazadas: { compraId: string; codigo: string }[];
}

export interface ResultadoPila {
  operacionId: string;
  filas: number;
}

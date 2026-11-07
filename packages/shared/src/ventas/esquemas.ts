import { z } from "zod";
import { MONEDAS } from "../clientes/esquemas.js";

// Esquemas y DTOs de ventas (spec 013). Reglas duras: los montos viajan SIEMPRE como cadenas decimales
// (nunca `number`; el frontend no suma ni compara) y las claves desconocidas se descartan (z.object).

const Q_MAX = 100;
const COMENTARIO_MAX = 500;
/** Un número de comprobante de 1 a 8 dígitos cabe en un entero seguro de JSON. */
const NUMERO_N_MAX = 99_999_999;

/** Cadena decimal canónica de NUMERIC(14,2): signo opcional, sin ceros a la izquierda, hasta 2 decimales. */
const MONTO = /^-?(0|[1-9]\d{0,11})(\.\d{1,2})?$/;
/** Igual, pero admite hasta 3 decimales: comparar contra 0.005 sin `number`. */
const MONTO_FILTRO = /^-?(0|[1-9]\d{0,11})(\.\d{1,3})?$/;
/** Tipo de cambio: 1 a 4 enteros y hasta 3 decimales (la escala de `TipoCambio`, spec 010). */
const TIPO_CAMBIO = /^(0|[1-9]\d{0,3})(\.\d{1,3})?$/;
const TIPO = /^\d{2}$/;
const SERIE_FILTRO = /^[A-Za-z0-9]{1,4}$/;
const SERIE = /^[A-Za-z0-9]{4}$/;
const NUMERO = /^\d{1,20}$/;
const FECHA = /^(\d{4})-(\d{2})-(\d{2})$/;

const entero = z.number().int().min(0);

const montoSchema = z.string().regex(MONTO);

function esFechaReal(valor: string): boolean {
  const m = FECHA.exec(valor);
  if (m === null) return false;
  const [anio, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const f = new Date(Date.UTC(anio, mes - 1, dia));
  return (
    f.getUTCFullYear() === anio &&
    f.getUTCMonth() === mes - 1 &&
    f.getUTCDate() === dia
  );
}

function esTipoCambioPositivo(valor: string): boolean {
  return TIPO_CAMBIO.test(valor) && /[1-9]/.test(valor);
}

// --- Lectura (D10) ---------------------------------------------------------------------------

export const TAMANOS_PAGINA_VENTAS = [10, 25, 50, "todas"] as const;
export type TamanoPaginaVentas = (typeof TAMANOS_PAGINA_VENTAS)[number];

const paginaSchema = z
  .union([z.string().regex(/^[1-9]\d{0,8}$/), z.number()])
  .transform((v) => Number(v))
  .pipe(z.number().int().min(1).max(999_999_999));

const tamanoSchema = z
  .union([z.string(), z.number()])
  .transform((v) => (v === "todas" ? v : typeof v === "number" ? v : /^\d+$/.test(v) ? Number(v) : NaN))
  .pipe(z.union([z.literal(10), z.literal(25), z.literal(50), z.literal("todas")]));

/** Query string de `GET …/ventas`. Todo opcional; `min` y `max` son cadenas decimales. */
export const filtrosVentasSchema = z.object({
  pagina: paginaSchema.optional(),
  tamano: tamanoSchema.optional(),
  q: z.string().max(Q_MAX).optional(),
  tipo: z.string().regex(TIPO).optional(),
  serie: z.string().regex(SERIE_FILTRO).optional(),
  min: z.string().regex(MONTO_FILTRO).optional(),
  max: z.string().regex(MONTO_FILTRO).optional(),
});
export type FiltrosVentas = z.infer<typeof filtrosVentasSchema>;

// --- Agregar una venta a mano (D9) ------------------------------------------------------------

/**
 * Cuerpo de `POST …/ventas`. Mismos nombres que `FilaVentaSire`. No verifica el cuadre ni la repetición de
 * la clave: eso lo decide el servicio (400 y 409). El origen, el cliente y el estudio nunca viajan aquí.
 */
export const ventaAgregarSchema = z
  .object({
    tipo: z.string().regex(TIPO),
    serie: z.string().regex(SERIE),
    numero: z.string().regex(NUMERO),
    fechaEmision: z.string().refine(esFechaReal),
    moneda: z.enum(MONEDAS),
    tipoCambio: z.string().refine(esTipoCambioPositivo).optional(),
    tipoDocContraparte: z.string().min(1).max(2).optional(),
    docContraparte: z.string().min(1).max(20),
    baseGravada: montoSchema,
    igv: montoSchema,
    exonerada: montoSchema,
    inafecta: montoSchema,
    isc: montoSchema,
    icbper: montoSchema,
    otros: montoSchema,
    total: montoSchema,
  })
  .refine((v) => v.tipoCambio === undefined || v.moneda === "USD", {
    path: ["tipoCambio"],
    message: "El tipo de cambio solo aplica a USD",
  });
export type VentaAgregarInput = z.infer<typeof ventaAgregarSchema>;

// --- Justificar un salto (D8) -----------------------------------------------------------------

const numeroNSchema = z.number().int().min(1).max(NUMERO_N_MAX);

/** Cuerpo de `POST …/saltos-justificados`. Que el rango esté dentro de un faltante actual lo decide el servicio. */
export const saltoJustificarSchema = z
  .object({
    tipo: z.string().regex(TIPO),
    serie: z.string().regex(SERIE_FILTRO),
    desde: numeroNSchema,
    hasta: numeroNSchema,
    comentario: z
      .string()
      .max(COMENTARIO_MAX)
      .refine((c) => c.trim().length > 0)
      // H-013-3: sin caracteres de control (Cc: C0, DEL y C1) salvo tabulación y saltos de línea (\t, \n, \r), que el
      // formulario (un `textarea`) puede producir y PostgreSQL acepta. El NUL en `text` daba 500.
      .refine((c) => !/(?![\t\n\r])\p{Cc}/u.test(c)),
  })
  .refine((v) => v.desde <= v.hasta, { path: ["hasta"], message: "desde debe ser <= hasta" });
export type SaltoJustificarInput = z.infer<typeof saltoJustificarSchema>;

// --- Importación de la propuesta (D6) ----------------------------------------------------------

/** Lista cerrada de motivos de fila (códigos, nunca texto libre ni el valor de la celda). */
export const MOTIVOS_FILA_VENTA = [
  "campo_obligatorio",
  "tipo_invalido",
  "serie_invalida",
  "numero_invalido",
  "fecha_invalida",
  "moneda_invalida",
  "tipo_cambio_requerido",
  "tipo_cambio_invalido",
  "documento_invalido",
  "monto_invalido",
  "descuadre",
  "duplicado_en_archivo",
  "celda_peligrosa",
] as const;
export type MotivoFilaVenta = (typeof MOTIVOS_FILA_VENTA)[number];

/**
 * D22: avisos que NO bloquean la importación (la fila es válida y se guarda tal cual, D3). Son los mismos códigos que
 * `descuadre` y `tipo_cambio_requerido` de `MOTIVOS_FILA_VENTA`, pero aquí son una lista cerrada propia; orden fijo.
 */
export const MOTIVOS_ADVERTENCIA_VENTA = ["descuadre", "tipo_cambio_requerido"] as const;
export type MotivoAdvertenciaVenta = (typeof MOTIVOS_ADVERTENCIA_VENTA)[number];

export const filaVistaPreviaVentasSchema = z.object({
  n: z.number().int().min(1),
  estado: z.enum(["valida", "error"]),
  motivos: z.array(z.enum(MOTIVOS_FILA_VENTA)),
  /** Siempre presente, vacía si no hay; nunca el monto ni el contenido de la celda. */
  advertencias: z.array(z.enum(MOTIVOS_ADVERTENCIA_VENTA)),
});
export type FilaVistaPreviaVentas = z.infer<typeof filaVistaPreviaVentasSchema>;

/** Respuesta de `POST …/importar/vista-previa`: ningún campo lleva el contenido de una celda. */
export const vistaPreviaVentasSchema = z.object({
  filas: z.array(filaVistaPreviaVentasSchema),
  /** Filas válidas (incluye las que traen advertencias). */
  validas: entero,
  conError: entero,
  /** Filas con alguna advertencia (D22); también cuentan en `validas`. */
  conAdvertencia: entero,
});
export type VistaPreviaVentas = z.infer<typeof vistaPreviaVentasSchema>;

/** Contadores de una descarga o importación, tal como los lista `GET …/propuestas`. */
export const informeImportacionVentasSchema = z.object({
  propuestaId: z.uuid(),
  recibidas: entero,
  nuevas: entero,
  iguales: entero,
  distintas: entero,
});
export type InformeImportacionVentas = z.infer<typeof informeImportacionVentasSchema>;

// --- DTOs de respuesta (solo tipos; montos como cadenas) -----------------------------------------

export type OrigenVenta = "sire" | "manual";

export interface MontosVentaDto {
  baseGravada: string;
  igv: string;
  exonerada: string;
  inafecta: string;
  isc: string;
  icbper: string;
  otros: string;
  total: string;
}

export interface VentaDto extends MontosVentaDto {
  id: string;
  origen: OrigenVenta;
  tipo: string;
  serie: string;
  numero: string;
  fechaEmision: string;
  tipoDocContraparte: string | null;
  docContraparte: string;
  moneda: "PEN" | "USD";
  tipoCambio: string | null;
}

export type AvisoLecturaVentas = "todas_limitada";

export interface PaginaVentasDto {
  filas: VentaDto[];
  total: number;
  pagina: number;
  tamano: number | "todas";
  avisos: AvisoLecturaVentas[];
}

export interface ResumenTipoVentasDto extends MontosVentaDto {
  tipo: string;
  cantidad: number;
}

export interface ResumenVentasDto {
  porTipo: ResumenTipoVentasDto[];
  total: MontosVentaDto & { cantidad: number };
  sinConvertir: { clave: string; moneda: string }[];
  avisos: "usd_sin_tipo_cambio"[];
}

export interface FaltanteVentasDto {
  desde: number;
  hasta: number;
  estado: "pendiente" | "justificado" | "parcial";
  /** Solo cuando una única justificación vigente cubre el faltante completo (D8). */
  comentario?: string;
  /** La justificación vigente que lo cubre: con ella se puede revertir tras recargar. Ausente si no hay una sola. */
  justificacionId?: string;
}

export interface SerieCorrelatividadDto {
  tipo: string;
  serie: string;
  estado: "completa" | "con_faltantes" | "no_evaluable";
  faltantes: FaltanteVentasDto[];
  noEvaluables: number;
}

export interface CorrelatividadVentasDto {
  series: SerieCorrelatividadDto[];
}

/** Respuesta 201 de `POST …/saltos-justificados`: el rango justificado y su comentario. */
export interface SaltoJustificadoDto {
  id: string;
  tipo: string;
  serie: string;
  desde: number;
  hasta: number;
  comentario: string;
}

export interface PropuestaVentasDto {
  id: string;
  fuente: "api" | "importacion";
  filasRecibidas: number;
  filasNuevas: number;
  filasIguales: number;
  filasDistintas: number;
  creadaEn: string;
}

export interface DiferenciaVentasDto {
  clave: string;
  tipo: string;
  serie: string;
  numero: string;
  origenExistente: OrigenVenta;
  campos: string[];
  valoresSire: Record<string, string>;
}

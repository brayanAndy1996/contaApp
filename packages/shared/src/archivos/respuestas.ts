import { z } from "zod";
import { DESTINOS_COMPRA, estadoPeriodoSchema, montoDecimalSchema } from "../compras/esquemas.js";
import { sha256HexSchema } from "./esquemas.js";

// Spec 012b (plan, Contratos: HTTP). DTOs del previo y de las versiones. `shared` no depende de `domain`: las formas
// repiten las de los tipos de dominio (Money -> cadena decimal). Los montos nunca son `number`.

const fechaIso = z.iso.datetime();
const entero = z.number().int().min(0);
/** Tope de errores y de excluidas que viajan en el previo; el resto se cuenta en `*Omitidos`. */
export const MAX_ITEMS_PREVIO = 1000;

export const MOTIVOS_NO_GENERABLE = ["prevalidacion_fallida", "formato_no_oficial", "periodo_generado", "cliente_archivado"] as const;
export const CODIGOS_AVISO_ARCHIVO = ["R-ISC", "R-NEW", "R-GP", "SALTO_CORRELATIVIDAD", "RAZON_SOCIAL_RECORTADA"] as const;
export type CodigoAvisoArchivo = (typeof CODIGOS_AVISO_ARCHIVO)[number];

export const errorPrevioSchema = z.object({
  filaId: z.uuid().nullable(),
  /** `SERIE-NUMERO` de la fila; `null` si el error no es de una fila; opcional para leer respuestas de un servidor anterior (T23a, P-3). */
  comprobante: z.string().min(1).nullable().optional(),
  codigo: z.string().min(1),
  campo: z.string().nullable(),
  destino: z.enum(DESTINOS_COMPRA).nullable(),
  explicacion: z.string(),
  diferencia: montoDecimalSchema.nullable(),
  /** Ventas: se puede excluir la fila (D12, P-8). */
  excluible: z.boolean(),
});
export type ErrorPrevioDto = z.infer<typeof errorPrevioSchema>;

export const avisoPrevioSchema = z.object({
  filaId: z.uuid().nullable(),
  /** `SERIE-NUMERO` de la fila; `null` si el aviso no es de una fila; opcional para leer respuestas de un servidor anterior (T23a, P-3). */
  comprobante: z.string().min(1).nullable().optional(),
  codigo: z.enum(CODIGOS_AVISO_ARCHIVO),
  explicacion: z.string(),
});
export type AvisoPrevioDto = z.infer<typeof avisoPrevioSchema>;

/** Resumen de cambios del TXT; ventas manda DG, DGNG y DNG en null. */
export const resumenArchivoSchema = z.object({
  modificadas: entero,
  excluidas: entero,
  agregadas: entero,
  impactoIgv: z.object({
    DG: montoDecimalSchema.nullable(),
    DGNG: montoDecimalSchema.nullable(),
    DNG: montoDecimalSchema.nullable(),
    total: montoDecimalSchema,
  }),
  filasSinConvertir: z.array(z.string()),
});
export type ResumenArchivoDto = z.infer<typeof resumenArchivoSchema>;

export const excluidaPrevioSchema = z.object({ filaId: z.uuid(), comprobante: z.string(), motivo: z.string() });
export type ExcluidaPrevioDto = z.infer<typeof excluidaPrevioSchema>;

/** `GET …/archivos/previo`. */
export const previoArchivoSchema = z.object({
  apto: z.boolean(),
  generable: z.boolean(),
  motivo: z.enum(MOTIVOS_NO_GENERABLE).nullable(),
  errores: z.array(errorPrevioSchema).max(MAX_ITEMS_PREVIO),
  erroresOmitidos: entero,
  avisos: z.array(avisoPrevioSchema),
  resumen: resumenArchivoSchema,
  excluidas: z.array(excluidaPrevioSchema).max(MAX_ITEMS_PREVIO),
  excluidasOmitidas: entero,
  formato: z.object({ id: z.string(), version: z.string(), oficial: z.boolean() }),
  estado: z.object({ estado: estadoPeriodoSchema, por: z.uuid().nullable(), en: fechaIso.nullable() }),
  huella: sha256HexSchema,
  ultimaVersion: z.object({ version: z.number().int().min(1), generadoEn: fechaIso }).nullable(),
  reabiertoTrasUltima: z.boolean(),
});
export type PrevioArchivoDto = z.infer<typeof previoArchivoSchema>;

/** `GET …/archivos` (un elemento). Nunca lleva la ruta del storage: `z.object` descarta cualquier clave desconocida. */
export const versionArchivoSchema = z.object({
  id: z.uuid(),
  version: z.number().int().min(1),
  generadoEn: fechaIso,
  generadoPor: z.uuid(),
  formato: z.object({ id: z.string(), version: z.string() }),
  provisional: z.boolean(),
  nombreZip: z.string().min(1),
  sha256Txt: sha256HexSchema,
  sha256Zip: sha256HexSchema,
  bytesZip: z.number().int().min(1),
  lineas: entero,
  resumen: resumenArchivoSchema,
  avisos: z.record(z.string(), entero),
});
export type VersionArchivoDto = z.infer<typeof versionArchivoSchema>;

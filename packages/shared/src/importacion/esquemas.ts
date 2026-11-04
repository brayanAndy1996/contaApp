import { z } from "zod";

/** Lista cerrada de motivos de fila (plan 007b, Contratos HTTP). Nunca texto libre. */
export const MOTIVOS_FILA_IMPORTACION = [
  "ruc_invalido",
  "duplicado_en_archivo",
  "duplicado",
  "responsable_inexistente",
  "responsable_no_asignable",
  "credencial_incompleta",
  "celda_peligrosa",
  "cupo_rucs",
] as const;
export type MotivoFilaImportacion = (typeof MOTIVOS_FILA_IMPORTACION)[number];

export const motivoFilaImportacionSchema = z.enum(MOTIVOS_FILA_IMPORTACION);

const entero = z.number().int().min(0);

export const filaVistaPreviaSchema = z.object({
  n: z.number().int().min(1),
  ruc: z.string(),
  estado: z.enum(["valida", "error"]),
  motivos: z.array(motivoFilaImportacionSchema),
  tieneSol: z.boolean(),
  tieneSire: z.boolean(),
  /** Con el motivo `duplicado`: el cliente existente está archivado (sugerir reactivar). */
  archivado: z.boolean().optional(),
});
export type FilaVistaPrevia = z.infer<typeof filaVistaPreviaSchema>;

/** Respuesta de `POST /clientes/importacion/vista-previa`: ningún campo lleva el valor de una clave. */
export const vistaPreviaSchema = z.object({
  filas: z.array(filaVistaPreviaSchema),
  validas: entero,
  conError: entero,
  cupoLibre: entero,
  excedentes: entero,
});
export type VistaPrevia = z.infer<typeof vistaPreviaSchema>;

export const filaNoImportadaSchema = z.object({
  n: z.number().int().min(1),
  ruc: z.string(),
  motivo: motivoFilaImportacionSchema,
  archivado: z.boolean().optional(),
});
export type FilaNoImportada = z.infer<typeof filaNoImportadaSchema>;

/** Respuesta de `POST /clientes/importacion/confirmar`. */
export const informeImportacionSchema = z.object({
  creadas: entero,
  noImportadas: z.array(filaNoImportadaSchema),
  consultasEncoladas: entero,
  consultasOmitidas: entero,
});
export type InformeImportacion = z.infer<typeof informeImportacionSchema>;

import { z } from "zod";

export const ESTADOS_TRABAJO = [
  "en_cola",
  "ejecutando",
  "completado",
  "error",
  "cancelado",
] as const;

export const MOTIVOS_TRABAJO = [
  "sunat_no_responde",
  "credencial_invalida",
  "datos_invalidos",
  "portal_cambio",
  "interrumpido",
  "acceso_retirado",
  "cancelado_usuario",
  "error_interno",
] as const;

export const PRIORIDADES = ["interactivo", "programado"] as const;

export type EstadoTrabajo = (typeof ESTADOS_TRABAJO)[number];
export type MotivoTrabajo = (typeof MOTIVOS_TRABAJO)[number];
export type Prioridad = (typeof PRIORIDADES)[number];

const estadoSchema = z.enum(ESTADOS_TRABAJO);
const motivoSchema = z.enum(MOTIVOS_TRABAJO);
const fechaIso = z.iso.datetime();

// `z.object` descarta las claves desconocidas: nunca salen tenantId, ruc, parámetros ni resultado.
export const trabajoVistaSchema = z.object({
  id: z.uuid(),
  tipo: z.string().min(1),
  clienteId: z.uuid(),
  estado: estadoSchema,
  posicion: z.number().int().min(1).nullable(),
  intentos: z.number().int().min(0),
  motivo: motivoSchema.nullable(),
  creadoEn: fechaIso,
  iniciadoEn: fechaIso.nullable(),
  terminadoEn: fechaIso.nullable(),
  creadoPor: z.object({ usuarioId: z.uuid() }).nullable(),
});

/** Un evento SSE `trabajo` por cambio de estado. */
export const eventoTrabajoSchema = trabajoVistaSchema;

export const listarTrabajosQuery = z.object({
  clienteId: z.uuid().optional(),
  estado: estadoSchema.optional(),
});

export type TrabajoVista = z.infer<typeof trabajoVistaSchema>;
export type EventoTrabajo = z.infer<typeof eventoTrabajoSchema>;
export type ListarTrabajosQuery = z.infer<typeof listarTrabajosQuery>;

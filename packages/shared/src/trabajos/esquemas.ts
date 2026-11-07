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
  /** AAAAMM (D24). Solo lo trae `sire.propuesta.descargar`; ningún otro parámetro del trabajo sale. */
  periodo: z
    .string()
    .regex(/^\d{4}(0[1-9]|1[0-2])$/)
    .nullish(),
});

/**
 * 007b D10 (T18a, D-1): `GET /trabajos` trae solo los 100 más recientes; `GET /trabajos/resumen` cuenta TODOS los
 * trabajos visibles por tipo y estado para que el panel no pierda el total con más de 100.
 */
export const resumenTrabajosSchema = z.array(
  z.object({
    tipo: z.string().min(1),
    estado: estadoSchema,
    total: z.number().int().min(0),
  }),
);

/** Un evento SSE `trabajo` por cambio de estado. */
export const eventoTrabajoSchema = trabajoVistaSchema;

export const listarTrabajosQuery = z.object({
  clienteId: z.uuid().optional(),
  estado: estadoSchema.optional(),
});

export type TrabajoVista = z.infer<typeof trabajoVistaSchema>;
export type ResumenTrabajos = z.infer<typeof resumenTrabajosSchema>;
export type EventoTrabajo = z.infer<typeof eventoTrabajoSchema>;
export type ListarTrabajosQuery = z.infer<typeof listarTrabajosQuery>;

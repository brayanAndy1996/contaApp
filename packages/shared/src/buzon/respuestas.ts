import { z } from "zod";
import { trabajoVistaSchema } from "../trabajos/esquemas.js";
import { LIMITE_MAX_MENSAJES_BUZON, MOTIVOS_CRITICO_BUZON, MOTIVOS_OMITIDO_BUZON, categoriaBuzonSchema } from "./esquemas.js";

// Spec 023 (plan: Contratos HTTP; D-3, D-4, D-8; CA-4, CA-8, CA-10). `z.object` descarta las claves desconocidas:
// nunca salen idSunat, tenantId, clienteId, rutas de storage ni sha256.
const fechaIso = z.iso.datetime();
const entero = z.number().int().min(0);

export const mensajeBuzonFilaSchema = z.object({
  id: z.uuid(),
  asunto: z.string().max(500),
  remitente: z.string().max(200),
  fecha: fechaIso,
  categoria: categoriaBuzonSchema,
  critico: z.boolean(),
  motivoCritico: z.enum(MOTIVOS_CRITICO_BUZON).nullable(),
  leidoEnSunat: z.boolean(),
  contenidoObtenido: z.boolean(),
  adjuntosDeclarados: entero,
});
export type MensajeBuzonFila = z.infer<typeof mensajeBuzonFilaSchema>;

export const adjuntoVistaSchema = z.object({
  id: z.uuid(),
  nombre: z.string().min(1).max(120),
  mime: z.string().nullable(),
  tamano: entero,
  omitido: z.enum(MOTIVOS_OMITIDO_BUZON).nullable(),
});
export type AdjuntoVista = z.infer<typeof adjuntoVistaSchema>;

/** `contenido` null = aún no obtenido. */
export const detalleMensajeSchema = z.object({
  mensaje: mensajeBuzonFilaSchema,
  contenido: z.string().nullable(),
  adjuntos: z.array(adjuntoVistaSchema),
});
export type DetalleMensaje = z.infer<typeof detalleMensajeSchema>;

export const estadoBuzonSchema = z.object({
  ultimaCaptura: fechaIso.nullable(),
  sincronizado: z.boolean(),
  revisarDesde: fechaIso.nullable(),
});
export type EstadoBuzon = z.infer<typeof estadoBuzonSchema>;

export const paginaMensajesBuzonSchema = z.object({
  estado: estadoBuzonSchema,
  mensajes: z.array(mensajeBuzonFilaSchema).max(LIMITE_MAX_MENSAJES_BUZON),
  siguiente: z.string().min(1).nullable(),
});
export type PaginaMensajesBuzon = z.infer<typeof paginaMensajesBuzonSchema>;

/** 202 trabajo nuevo, 200 trabajo vivo. */
export const revisarBuzonRespuestaSchema = z.object({ trabajo: trabajoVistaSchema });
export type RevisarBuzonRespuesta = z.infer<typeof revisarBuzonRespuestaSchema>;

/** `trabajo: null` = el contenido ya se obtuvo (200). */
export const abrirMensajeRespuestaSchema = z.object({ trabajo: trabajoVistaSchema.nullable() });
export type AbrirMensajeRespuesta = z.infer<typeof abrirMensajeRespuestaSchema>;

import { z } from "zod";

// Spec 024 (plan: Contratos: shared; D-5 a D-8; U-3; CA-4, CA-5, CA-7). Atención de mensajes del buzón.
const fechaIso = z.iso.datetime();

/** Estado vigente de un mensaje: `historico` = anterior a la primera captura (D-12), nunca cuenta como pendiente. */
export const ESTADOS_ATENCION = ["pendiente", "atendido", "historico"] as const;
export type EstadoAtencion = (typeof ESTADOS_ATENCION)[number];
export const estadoAtencionSchema = z.enum(ESTADOS_ATENCION);

/** Filtro `atencion` de la bandeja (valores de query). */
export const FILTROS_ATENCION = ["pendientes", "atendidos", "historicos", "todos"] as const;
export type FiltroAtencion = (typeof FILTROS_ATENCION)[number];

export const LARGO_MAX_COMENTARIO_ATENCION = 500;
export const LOTE_MAX_ATENCION = 100;

const CONTROLES = /[^\P{Cc}\n]/u; // control (\p{Cc}) distinto de \n
const BIDI = /[‪-‮⁦-⁩‎‏؜]/;

/** Texto plano: se recorta; 1..500; sin controles (salvo \n) ni caracteres bidi. Se escapa al pintar, no aquí. */
export const comentarioAtencionSchema = z
  .string()
  .trim()
  .min(1)
  .max(LARGO_MAX_COMENTARIO_ATENCION)
  .refine((t) => !CONTROLES.test(t) && !BIDI.test(t), { message: "comentario con caracteres no permitidos" });

export type AccionAtencion = "marcar" | "deshacer";

/** Marcar un crítico exige comentario (D-5); deshacer nunca. */
export function comentarioRequerido(entrada: { critico: boolean; accion: AccionAtencion }): boolean {
  return entrada.accion === "marcar" && entrada.critico;
}

export const atenderMensajeBodySchema = z
  .object({
    accion: z.enum(["marcar", "deshacer"]),
    comentario: comentarioAtencionSchema.optional(),
  })
  .strict();
export type AtenderMensajeBody = z.infer<typeof atenderMensajeBodySchema>;

/** Solo marca (U-3). Ids únicos sin distinguir mayúsculas. */
export const atenderLoteBodySchema = z
  .object({
    mensajes: z
      .array(z.uuid())
      .min(1)
      .max(LOTE_MAX_ATENCION)
      .refine((ids) => new Set(ids.map((i) => i.toLowerCase())).size === ids.length, { message: "ids repetidos" }),
    comentario: comentarioAtencionSchema.optional(),
  })
  .strict();
export type AtenderLoteBody = z.infer<typeof atenderLoteBodySchema>;

export const respuestaLoteSchema = z.object({
  atendidos: z.array(z.uuid()),
  omitidos: z.array(z.uuid()),
});
export type RespuestaLote = z.infer<typeof respuestaLoteSchema>;

export const usuarioAtencionSchema = z.object({ id: z.uuid(), nombre: z.string() });
export type UsuarioAtencion = z.infer<typeof usuarioAtencionSchema>;

/** Evento del historial (solo inserción). */
export const eventoAtencionSchema = z.object({
  accion: z.enum(["atendido", "deshecho"]),
  comentario: z.string().nullable(),
  usuario: usuarioAtencionSchema,
  en: fechaIso,
});
export type EventoAtencion = z.infer<typeof eventoAtencionSchema>;

/** Atención de una fila de lista: sin comentario (solo el detalle lo trae). */
export const atencionFilaSchema = z.object({
  estado: estadoAtencionSchema,
  por: usuarioAtencionSchema.nullable(),
  en: fechaIso.nullable(),
});
export type AtencionFila = z.infer<typeof atencionFilaSchema>;

/** Atención en el detalle: la de la fila más el comentario del último evento `atendido` vigente. */
export const atencionDetalleSchema = atencionFilaSchema.extend({ comentario: z.string().nullable() });
export type AtencionDetalle = z.infer<typeof atencionDetalleSchema>;

import { z } from "zod";
import { MOTIVOS_TRABAJO } from "../trabajos/esquemas.js";

// Spec 017 (D-8, D-11, D-12; P-3, P-5; CA-12). Notificaciones y aviso en vivo. Los `params` son códigos y números,
// discriminados por `tipo` y estrictos: nunca viaja un secreto, un RUC ni una razón social dentro de ellos.
export const TIPOS_NOTIFICACION = ["credencial_invalida", "trabajo_terminado", "plan_limite"] as const;
export type TipoNotificacion = (typeof TIPOS_NOTIFICACION)[number];

const fechaIso = z.iso.datetime();
const entero = z.number().int().min(0);

const paramsCredencialInvalida = z.strictObject({ credencial: z.enum(["sol", "sire_api"]) });
const paramsTrabajoTerminado = z.strictObject({
  tipoTrabajo: z.string().min(1),
  estado: z.enum(["completado", "error"]),
  motivo: z.enum(MOTIVOS_TRABAJO).nullable(),
});
const paramsPlanLimite = z.strictObject({
  recurso: z.enum(["rucs", "usuarios"]),
  umbral: z.union([z.literal(90), z.literal(100)]),
  usado: entero,
  limite: entero,
});

const baseNotificacion = z.object({
  id: z.uuid(),
  creadaEn: fechaIso,
  leidaEn: fechaIso.nullable(),
  cliente: z.object({ id: z.uuid(), razonSocial: z.string() }).nullable(),
  trabajoId: z.uuid().nullable(),
});

export const notificacionSchema = z.discriminatedUnion("tipo", [
  baseNotificacion.extend({ tipo: z.literal("credencial_invalida"), params: paramsCredencialInvalida }),
  baseNotificacion.extend({ tipo: z.literal("trabajo_terminado"), params: paramsTrabajoTerminado }),
  baseNotificacion.extend({ tipo: z.literal("plan_limite"), params: paramsPlanLimite }),
]);
export type Notificacion = z.infer<typeof notificacionSchema>;

/** Máximo de filas por página (CA-12). */
export const MAX_PAGINA_NOTIFICACIONES = 50;

export const paginaNotificacionesSchema = z.object({
  items: z.array(notificacionSchema).max(MAX_PAGINA_NOTIFICACIONES),
  siguiente: z.string().nullable(),
});
export type PaginaNotificaciones = z.infer<typeof paginaNotificacionesSchema>;

/** Conteo con tope: 100 significa «99+». */
export const TOPE_NO_LEIDAS = 100;
export const noLeidasSchema = z.object({ noLeidas: z.number().int().min(0).max(TOPE_NO_LEIDAS) });
export type NoLeidas = z.infer<typeof noLeidasSchema>;

/** Cuerpo de `POST /notificaciones/leidas`. Estricto: un usuarioId o tenantId extra es 400 y nunca cambia el actor (D-11). */
export const marcarLeidasSchema = z.strictObject({ hasta: fechaIso });
export type MarcarLeidas = z.infer<typeof marcarLeidasSchema>;

/** Respuesta de `POST /notificaciones/leidas`. */
export const marcadasSchema = z.object({ marcadas: entero });
export type Marcadas = z.infer<typeof marcadasSchema>;

/** Aviso por Redis hacia el stream SSE: sin contenido, solo a quién avisar. */
export const MAX_DESTINATARIOS_AVISO = 200;
export const avisoNotificacionSchema = z.strictObject({
  evento: z.literal("notificacion"),
  destinatarios: z.array(z.uuid()).min(1).max(MAX_DESTINATARIOS_AVISO),
});
export type AvisoNotificacion = z.infer<typeof avisoNotificacionSchema>;

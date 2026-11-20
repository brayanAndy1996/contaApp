import { z } from "zod";

// Spec 023 (plan: Contratos HTTP y Dominio; D-7, D-8; P-3). Códigos y query string del buzón SOL.
// Las cuatro críticas son las de RF-122 y coinciden con las del dominio (packages/domain/src/buzon).
export const CATEGORIAS_CRITICAS_BUZON = [
  "coactiva",
  "resolucion_determinacion",
  "resolucion_multa",
  "requerimiento_fiscalizacion",
] as const;
export const CATEGORIAS_BUZON = [...CATEGORIAS_CRITICAS_BUZON, "otro"] as const;
export type CategoriaBuzon = (typeof CATEGORIAS_BUZON)[number];
export type CategoriaCriticaBuzon = (typeof CATEGORIAS_CRITICAS_BUZON)[number];
export const categoriaBuzonSchema = z.enum(CATEGORIAS_BUZON);

/** Valores de `buzon_mensaje.motivo_critico`. */
export const MOTIVOS_CRITICO_BUZON = ["codigo", "asunto", "duda"] as const;
export type MotivoCriticoBuzon = (typeof MOTIVOS_CRITICO_BUZON)[number];
/** Valores de `buzon_adjunto.omitido`. */
export const MOTIVOS_OMITIDO_BUZON = ["mime", "tamano", "tope_mensaje"] as const;
export type MotivoOmitidoBuzon = (typeof MOTIVOS_OMITIDO_BUZON)[number];

export const LIMITE_MAX_MENSAJES_BUZON = 100;

/** Query de `GET …/buzon/mensajes`. Las claves desconocidas (clienteId, tenantId) se descartan. */
export const listarMensajesQuery = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limite: z.preprocess(
    (v) => (typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v),
    z.number().int().min(1).max(LIMITE_MAX_MENSAJES_BUZON).optional(),
  ),
});
export type ListarMensajesQuery = z.infer<typeof listarMensajesQuery>;

import { z } from "zod";
import { autorSchema } from "../autor.js";
import { accionAuditoriaSchema } from "./acciones.js";

// Spec 017 (P-2, CA-12, CA-14). Fila y página de `GET /auditoria`. `z.object` descarta las claves ajenas
// (tenantId, usuario_id crudo). Nunca lleva secretos: `datos` es una lista blanca que fija la BD (D-5).
export const TIPOS_ACTOR_AUDITORIA = ["usuario", "trabajo", "sistema"] as const;
export type TipoActorAuditoria = (typeof TIPOS_ACTOR_AUDITORIA)[number];

export const actorAuditoriaSchema = z.object({
  tipo: z.enum(TIPOS_ACTOR_AUDITORIA),
  autor: autorSchema.nullable(),
  trabajoId: z.uuid().nullable(),
});

export const filaAuditoriaSchema = z.object({
  id: z.uuid(),
  ocurridaEn: z.iso.datetime(),
  accion: accionAuditoriaSchema,
  actor: actorAuditoriaSchema,
  cliente: z.object({ id: z.uuid(), ruc: z.string(), razonSocial: z.string() }).nullable(),
  entidad: z.string(),
  /** Null en lo que no tiene id propio (p. ej. el cambio de estado de un periodo: su clave es cliente + libro + periodo). */
  entidadId: z.uuid().nullable(),
  datos: z.record(z.string(), z.unknown()),
});
export type FilaAuditoria = z.infer<typeof filaAuditoriaSchema>;

/** Máximo de filas por página (CA-12). */
export const MAX_PAGINA_AUDITORIA = 50;

export const paginaAuditoriaSchema = z.object({
  items: z.array(filaAuditoriaSchema).max(MAX_PAGINA_AUDITORIA),
  siguiente: z.string().nullable(),
});
export type PaginaAuditoria = z.infer<typeof paginaAuditoriaSchema>;

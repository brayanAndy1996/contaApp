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
  /**
   * Spec 017 (P-4): el usuario AFECTADO cuando el sujeto de la acción es otro usuario (`miembro.*`, `asignacion.*`,
   * `invitacion.*`), con la forma de `actor.autor` (D-12: inactivo conserva el nombre; un id que no se resuelve da `nombre: null`).
   * `null` en las demás acciones y cuando no se conoce (miembro ya eliminado, invitación aún sin aceptar). Nunca lleva el
   * correo de una invitación (D-5).
   */
  objetivo: autorSchema.nullable(),
});
export type FilaAuditoria = z.infer<typeof filaAuditoriaSchema>;

/**
 * Forma de `datos.cambios` en `cliente.editado` (trigger de la BD): `{ columna: [antes, después] }`, con la columna tal como está en
 * la BD (`ruc`, `razon_social`, `estado_contribuyente`, `condicion_contribuyente`, `regimen`, `zona`, `ventas_exoneradas`,
 * `ventas_mixtas`, `moneda_habitual`); nunca ids ni marcas de tiempo. Los valores son texto, booleano o null.
 */
export const cambiosClienteAuditoriaSchema = z.record(
  z.string(),
  z.tuple([
    z.union([z.string(), z.boolean(), z.null()]),
    z.union([z.string(), z.boolean(), z.null()]),
  ]),
);
export type CambiosClienteAuditoria = z.infer<typeof cambiosClienteAuditoriaSchema>;

/** Máximo de filas por página (CA-12). */
export const MAX_PAGINA_AUDITORIA = 50;

export const paginaAuditoriaSchema = z.object({
  items: z.array(filaAuditoriaSchema).max(MAX_PAGINA_AUDITORIA),
  siguiente: z.string().nullable(),
});
export type PaginaAuditoria = z.infer<typeof paginaAuditoriaSchema>;

import { z } from "zod";
import { accionAuditoriaSchema } from "./acciones.js";

// Spec 031 (D-2, D-6, CA-2, CA-7). Consulta de auditoría con filtros. Todo valor se valida aquí (400 sin abrir
// transacción) y viaja a la BD como parámetro; ningún filtro forma parte del texto SQL.

/** Máximo de acciones por consulta (CA-7). */
export const MAX_ACCIONES_CONSULTA_AUDITORIA = 10;

/** Fecha de calendario real `AAAA-MM-DD` (rechaza `2026-02-30`, `2026-2-3`, horas, espacios). */
const fechaSchema = z.iso.date();

// Una acción suelta (como llega de la URL) se toma como lista de uno.
const accionesSchema = z.preprocess(
  (v) => (typeof v === "string" ? [v] : v),
  z
    .array(accionAuditoriaSchema)
    .min(1)
    .max(MAX_ACCIONES_CONSULTA_AUDITORIA)
    .refine((l) => new Set(l).size === l.length, { message: "acciones repetidas" }),
);

export const consultaAuditoriaSchema = z
  .strictObject({
    usuarioId: z.uuid().optional(),
    clienteId: z.uuid().optional(),
    accion: accionesSchema.optional(),
    desde: fechaSchema.optional(),
    hasta: fechaSchema.optional(),
    cursor: z.string().optional(),
  })
  .refine((c) => c.desde === undefined || c.hasta === undefined || c.desde <= c.hasta, {
    message: "desde no puede ser posterior a hasta",
    path: ["desde"],
  });
export type ConsultaAuditoria = z.infer<typeof consultaAuditoriaSchema>;

/** `GET /auditoria/opciones` (D-6): búsqueda por texto y, opcionalmente, un cliente. */
export const consultaOpcionesAuditoriaSchema = z.strictObject({
  q: z.string().min(1).max(60).optional(),
  clienteId: z.uuid().optional(),
});
export type ConsultaOpcionesAuditoria = z.infer<typeof consultaOpcionesAuditoriaSchema>;

/** Respuesta de `GET /auditoria/opciones`. `z.object` descarta correo y tenantId. */
export const opcionesAuditoriaSchema = z.object({
  miembros: z.array(z.object({ id: z.uuid(), nombre: z.string(), activo: z.boolean() })),
  clientes: z.array(
    z.object({ id: z.uuid(), ruc: z.string(), razonSocial: z.string(), archivado: z.boolean() }),
  ),
});
export type OpcionesAuditoria = z.infer<typeof opcionesAuditoriaSchema>;

/** Perú no tiene horario de verano: UTC−05:00 fijo todo el año. */
const HORAS_LIMA_A_UTC = 5;

function medianocheLima(dia: string, sumarDias: number): Date {
  const [a, m, d] = dia.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(a, m - 1, d + sumarDias, HORAS_LIMA_A_UTC));
}

/**
 * Rango de fechas de Lima a instantes UTC: `desde` = 00:00 Lima de ese día; `hastaExclusivo` = 00:00 Lima del día
 * siguiente a `hasta` (el día `hasta` entra completo). `null` donde falta el filtro.
 */
export function rangoLima(desde?: string, hasta?: string): { desde: Date | null; hastaExclusivo: Date | null } {
  return {
    desde: desde === undefined ? null : medianocheLima(desde, 0),
    hastaExclusivo: hasta === undefined ? null : medianocheLima(hasta, 1),
  };
}

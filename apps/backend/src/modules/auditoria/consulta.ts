import {
  consultaAuditoriaSchema,
  consultaOpcionesAuditoriaSchema,
  rangoLima,
  type ConsultaOpcionesAuditoria,
} from "@contapp/shared";
import type { FiltrosAuditoria } from "@contapp/db";
import { AccesoError } from "../acceso/errores.js";
import { decodificarCursor, type PosicionCursor } from "../notificaciones/cursor.js";

// Spec 031 (D-1, D-2, D-6, CA-7). Lector propio de la consulta de auditoría: valida con los esquemas estrictos de `shared` y
// decodifica el cursor ANTES de abrir `withTenant`; cualquier fallo es 400 `solicitud_invalida` sin eco de la entrada.

export interface ConsultaLeida {
  filtros: FiltrosAuditoria;
  antes: PosicionCursor | undefined;
}

const invalida = (): never => {
  throw new AccesoError("solicitud_invalida");
};

/** `GET /auditoria`: filtros listos para `listarAuditoria` (fechas de Lima a UTC) y la posición del cursor. */
export function leerConsultaAuditoria(query: unknown): ConsultaLeida {
  const r = consultaAuditoriaSchema.safeParse(query ?? {});
  if (!r.success) return invalida();
  const c = r.data;
  const { desde, hastaExclusivo } = rangoLima(c.desde, c.hasta);
  return {
    filtros: {
      usuarioId: c.usuarioId?.toLowerCase() ?? null,
      clienteId: c.clienteId?.toLowerCase() ?? null,
      acciones: c.accion ?? null,
      desde,
      hastaExclusivo,
    },
    antes: decodificarCursor(c.cursor),
  };
}

/** `GET /auditoria/opciones`: `q` (1–60) y `clienteId` opcionales. */
export function leerConsultaOpciones(query: unknown): ConsultaOpcionesAuditoria {
  const r = consultaOpcionesAuditoriaSchema.safeParse(query ?? {});
  if (!r.success) return invalida();
  return r.data;
}

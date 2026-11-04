import type { Encolador, ResultadoLote } from "../trabajos/encolador.js";

/** Tipo de trabajo que completa razón social, estado y condición desde SUNAT (spec 007b, D1). */
export const TIPO_CONSULTA_RUC = "cliente.consultar_ruc";

/**
 * Fracción de `max_pendientes_tenant` hasta la que las consultas de RUC pueden llenar la cola `xml` del estudio (plan 007b:
 * Carga de la cola): el resto del tope queda para `xml.obtener` y demás trabajos interactivos.
 */
export const RESERVA_CONSULTA_RUC = 0.5;

/**
 * Encola una `cliente.consultar_ruc` (programado) por cliente. Se llama DESPUÉS del commit del alta: nunca lanza, y lo que
 * no se encola (Redis o BD caídos, reserva agotada) se cuenta en `omitidas`; el cliente conserva su razón social provisional.
 */
export async function encolarConsultasRuc(
  encolador: Pick<Encolador, "encolarLote">,
  ctx: { tenantId: string; userId: string },
  clienteIds: readonly string[],
): Promise<ResultadoLote> {
  if (clienteIds.length === 0) return { encoladas: 0, omitidas: 0 };
  try {
    return await encolador.encolarLote(
      ctx,
      clienteIds.map((clienteId) => ({
        tipo: TIPO_CONSULTA_RUC,
        clienteId,
        parametros: {},
        prioridad: "programado" as const,
        creadoPor: ctx.userId,
      })),
      { reserva: RESERVA_CONSULTA_RUC },
    );
  } catch {
    return { encoladas: 0, omitidas: clienteIds.length };
  }
}

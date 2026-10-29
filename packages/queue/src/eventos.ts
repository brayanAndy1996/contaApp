// Eventos de cambio de estado (pub/sub `eventos:{tenantId}`), que el backend reenvía por SSE con el
// alcance de cada usuario. El mensaje es exactamente la vista pública (eventoTrabajoSchema): nunca
// lleva RUC, parámetros, resultado ni tenantId. Se publica después del commit y sus errores no se
// propagan (el panel se resincroniza con GET /trabajos).
import type { TrabajoFila } from "@contapp/db";
import { eventoTrabajoSchema, type EventoTrabajo } from "@contapp/shared";
import { crearClaves } from "./claves.js";
import { registrarFallo, type ClienteRedis } from "./tipos.js";

type FilaEvento = Pick<
  TrabajoFila,
  "id" | "tipo" | "clienteId" | "intentos" | "creadoPor" | "creadoEn"
> &
  Partial<Pick<TrabajoFila, "iniciadoEn" | "terminadoEn">>;

const iso = (d: Date | null | undefined): string | null =>
  d === null || d === undefined ? null : d.toISOString();

/** Vista pública de una fila tras una transición (posición null: fuera de la lista no se calcula). */
export function vistaDeFila(
  f: FilaEvento,
  cambio: Pick<EventoTrabajo, "estado" | "motivo"> & {
    intentos?: number;
    iniciadoEn?: Date | null;
    terminadoEn?: Date | null;
  },
): EventoTrabajo {
  return {
    id: f.id,
    tipo: f.tipo,
    clienteId: f.clienteId,
    estado: cambio.estado,
    posicion: null,
    intentos: cambio.intentos ?? f.intentos,
    motivo: cambio.motivo,
    creadoEn: f.creadoEn.toISOString(),
    iniciadoEn: iso(
      cambio.iniciadoEn !== undefined ? cambio.iniciadoEn : f.iniciadoEn,
    ),
    terminadoEn: iso(
      cambio.terminadoEn !== undefined ? cambio.terminadoEn : f.terminadoEn,
    ),
    creadoPor: f.creadoPor === null ? null : { usuarioId: f.creadoPor },
  };
}

/** PUBLISH eventos:{tenantId} con la vista validada; nunca lanza. */
export async function publicarEvento(
  redis: Pick<ClienteRedis, "publish">,
  tenantId: string,
  evento: EventoTrabajo,
  opciones: { prefijo?: string } = {},
): Promise<void> {
  const r = eventoTrabajoSchema.safeParse(evento);
  if (!r.success) {
    registrarFallo("evento de trabajo inválido; no se publica");
    return;
  }
  try {
    await redis.publish(
      crearClaves(opciones.prefijo).eventos(tenantId),
      JSON.stringify(r.data),
    );
  } catch {
    registrarFallo("no se pudo publicar el evento de trabajo");
  }
}

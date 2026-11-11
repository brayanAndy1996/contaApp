// Adaptador Redis del puerto `Notificador` (spec 017, D-9, D-14): publica `{ evento: "notificacion", destinatarios }` en
// `eventos:{tenantId}` con `publicarAvisoNotificacion`, que nunca lanza ni deja el mensaje del error. El hecho ya está
// confirmado y la notificación guardada: si el aviso se pierde, la campana se pone al día al recargar.
import { publicarAvisoNotificacion, type ClienteRedis } from "@contapp/queue";
import {
  loggerConsola,
  registrar,
  type LoggerTrabajos,
  type Notificador,
} from "./registro.js";

export class NotificadorEventos implements Notificador {
  constructor(
    private readonly redis: Pick<ClienteRedis, "publish">,
    private readonly opciones: {
      prefijo?: string;
      logger?: LoggerTrabajos;
    } = {},
  ) {}

  async avisar(tenantId: string, usuarioIds: string[]): Promise<void> {
    try {
      await publicarAvisoNotificacion(this.redis, tenantId, usuarioIds, {
        ...(this.opciones.prefijo === undefined
          ? {}
          : { prefijo: this.opciones.prefijo }),
      });
    } catch {
      // publicarAvisoNotificacion no lanza; por si acaso, solo un código (sin el error)
      registrar(this.opciones.logger ?? loggerConsola, "warn", {
        evento: "aviso_notificacion_fallo",
        tenant_id: tenantId,
        codigo: "publicacion_fallida",
      });
    }
  }
}

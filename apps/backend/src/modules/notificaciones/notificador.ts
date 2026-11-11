import { Inject, Injectable } from "@nestjs/common";
import { destinatariosNuevos, type Tx } from "@contapp/db";
import { publicarAvisoNotificacion } from "@contapp/queue";
import { RedisTrabajos } from "../trabajos/redis.js";

/**
 * Aviso en vivo de notificaciones nuevas (spec 017, D-9). Se llama DESPUÉS del commit del hecho, con lo que devolvió
 * `destinatariosNuevos(tx)` dentro de la transacción. Sin contenido: solo a quién avisar. Nunca lanza ni espera de más
 * (un Redis caído no revierte ni retrasa el hecho; la campana se pone al día al recargar).
 */
export interface Notificador {
  avisar(tenantId: string, destinatarios: readonly string[]): Promise<void>;
}

/** Token de inyección de `Notificador` (lo exporta `TrabajosModule`, que posee la conexión Redis). */
export const NOTIFICADOR = Symbol("NOTIFICACIONES_NOTIFICADOR");

@Injectable()
export class NotificadorRedis implements Notificador {
  constructor(@Inject(RedisTrabajos) private readonly redis: RedisTrabajos) {}

  async avisar(tenantId: string, destinatarios: readonly string[]): Promise<void> {
    if (destinatarios.length === 0) return;
    try {
      const redis = this.redis.publicador();
      if (redis === null) return;
      await publicarAvisoNotificacion(redis, tenantId, [...destinatarios], { prefijo: this.redis.prefijo });
    } catch {
      // El aviso es un extra: la notificación ya está en la BD.
    }
  }
}

/**
 * Destinatarios de las notificaciones que ESTA transacción acaba de crear (`destinatariosNuevos`), para avisarles tras el
 * commit. Sin `Notificador` no hay a quién avisar y no consulta nada (las pruebas unitarias de los servicios no lo inyectan).
 */
export async function destinatariosPendientes(notificador: Notificador | undefined, tx: Tx): Promise<string[]> {
  return notificador === undefined ? [] : destinatariosNuevos(tx);
}

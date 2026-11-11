import { Inject, Injectable } from "@nestjs/common";
import {
  contarNoLeidas,
  listarNotificaciones,
  marcarLeida,
  marcarLeidasHasta,
  MAX_PAGINA_NOTIFICACIONES,
  TOPE_NO_LEIDAS,
  type ContappDb,
  type FilaNotificacion,
  type Tx,
} from "@contapp/db";
import {
  marcarLeidasSchema,
  notificacionSchema,
  type Marcadas,
  type NoLeidas,
  type Notificacion,
  type PaginaNotificaciones,
} from "@contapp/shared";
import { AccesoError } from "../acceso/errores.js";
import { DB } from "../auth/inyeccion.js";
import type { SesionResuelta } from "../auth/auth.service.js";
import { contextoDe, esUuid } from "../clientes/contexto.js";
import { actorDe } from "../trabajos/trabajos.service.js";
import { codificarCursor, leerConsulta } from "./cursor.js";

/** Fila de BD -> DTO de D-11: sin `tenantId`, `usuarioId` ni `claveDedupe`. Lo que no cumple el contrato (tipo reservado) no sale. */
function aDto(f: FilaNotificacion): Notificacion | null {
  const r = notificacionSchema.safeParse({
    id: f.id,
    tipo: f.tipo,
    creadaEn: f.creadaEn.toISOString(),
    leidaEn: f.leidaEn === null ? null : f.leidaEn.toISOString(),
    cliente: f.clienteId === null ? null : { id: f.clienteId, razonSocial: f.razonSocial ?? "" },
    trabajoId: f.trabajoId,
    params: f.params,
  });
  return r.success ? r.data : null;
}

/**
 * Notificaciones del usuario de la sesión (spec 017, D-10, D-11; CA-11, CA-12). Todo en `withTenant` con el actor releído:
 * el alcance (`filtroAlcance` de 005) oculta las de clientes no asignados sin borrar nada. Sin SQL propio.
 */
@Injectable()
export class NotificacionesService {
  constructor(@Inject(DB) private readonly db: Pick<ContappDb, "withTenant">) {}

  async listar(sesion: SesionResuelta, query: unknown): Promise<PaginaNotificaciones> {
    const antes = leerConsulta(query);
    return this.db.withTenant(contextoDe(sesion), async (tx) => {
      const alcance = await this.alcance(tx, sesion);
      const filas = await listarNotificaciones(tx, alcance, {
        ...(antes === undefined ? {} : { antes }),
        limite: MAX_PAGINA_NOTIFICACIONES,
      });
      const ultima = filas[filas.length - 1];
      let siguiente: string | null = null;
      if (ultima !== undefined && filas.length === MAX_PAGINA_NOTIFICACIONES) {
        // Una página llena solo da cursor si hay al menos una fila más (no se inventa una página vacía).
        const mas = await listarNotificaciones(tx, alcance, {
          antes: { en: ultima.creadaEn, id: ultima.id },
          limite: 1,
        });
        if (mas.length > 0) siguiente = codificarCursor({ en: ultima.creadaEn, id: ultima.id });
      }
      return {
        items: filas.map(aDto).filter((x): x is Notificacion => x !== null),
        siguiente,
      };
    });
  }

  async noLeidas(sesion: SesionResuelta, query: unknown): Promise<NoLeidas> {
    if (query !== undefined && query !== null && (typeof query !== "object" || Object.keys(query).length > 0)) {
      throw new AccesoError("solicitud_invalida");
    }
    return this.db.withTenant(contextoDe(sesion), async (tx) => ({
      noLeidas: await contarNoLeidas(tx, await this.alcance(tx, sesion), TOPE_NO_LEIDAS),
    }));
  }

  async marcarHasta(sesion: SesionResuelta, cuerpo: unknown): Promise<Marcadas> {
    const r = marcarLeidasSchema.safeParse(cuerpo);
    if (!r.success) throw new AccesoError("solicitud_invalida");
    const hasta = new Date(r.data.hasta);
    return this.db.withTenant(contextoDe(sesion), async (tx) => ({
      marcadas: await marcarLeidasHasta(tx, await this.alcance(tx, sesion), hasta),
    }));
  }

  /** Idempotente. Ajena, de otro estudio, de un cliente ya no visible, inexistente o mal formada: el mismo 404. */
  async marcar(sesion: SesionResuelta, id: string, cuerpo: unknown): Promise<void> {
    if (cuerpo !== undefined && cuerpo !== null) {
      if (typeof cuerpo !== "object" || Array.isArray(cuerpo) || Object.keys(cuerpo).length > 0) {
        throw new AccesoError("solicitud_invalida");
      }
    }
    if (!esUuid(id)) throw new AccesoError("no_encontrado");
    const hecho = await this.db.withTenant(contextoDe(sesion), async (tx) =>
      marcarLeida(tx, id.toLowerCase(), await this.alcance(tx, sesion)),
    );
    if (!hecho) throw new AccesoError("no_encontrado");
  }

  /** Membresía ACTIVA releída en la transacción (un desactivado ya no lee nada). */
  private async alcance(tx: Tx, sesion: SesionResuelta) {
    const actor = await actorDe(tx, sesion.usuarioId);
    if (actor === null) throw new AccesoError("estudio_requerido");
    return actor.alcance;
  }
}

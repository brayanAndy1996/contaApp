import { Inject, Injectable } from "@nestjs/common";
import {
  aplicarAtencionBuzon,
  BuzonRepoError,
  clienteVisible,
  detalleAtencion,
  type Alcance,
  type ContappDb,
  type Tx,
} from "@contapp/db";
import {
  atenderLoteBodySchema,
  atenderMensajeBodySchema,
  type AtencionDetalle,
  type RespuestaLote,
} from "@contapp/shared";
import { AccesoError } from "../acceso/errores.js";
import type { SesionResuelta } from "../auth/auth.service.js";
import { DB } from "../auth/inyeccion.js";
import { contextoDe } from "../clientes/contexto.js";
import { conReintentoUnico, exigirCliente, idDe } from "./apoyo.js";
import { BuzonError } from "./errores.js";
import { aAtencionDetalle } from "./mapeo.js";

/** `cambiada`: otra persona ya cambió el mensaje (409 `atencion_cambiada`); lleva el estado vigente. */
export interface ResultadoAtender {
  cambiada: boolean;
  atencion: AtencionDetalle;
}

/** Clientes de los mensajes pedidos y cuántos mensajes existen en el estudio (la RLS deja fuera los de otro). Texto estático. */
const SQL_CLIENTES_DE_MENSAJES = `select m.cliente_id, count(*)::integer as n
  from buzon_mensaje m
 where m.id = any($1::uuid[])
 group by m.cliente_id`;

/** Errores de la función acotada `buzon_atencion_aplicar` (0060) → códigos de la API. Lo demás se propaga (500, sin eco). */
function traducir(e: unknown): never {
  if (e instanceof BuzonRepoError) {
    switch (e.codigo) {
      case "P0002":
        throw new AccesoError("no_encontrado");
      case "55000":
        throw new AccesoError("cliente_archivado");
      case "22004":
        throw new BuzonError("comentario_requerido");
      case "22023":
        throw new AccesoError("solicitud_invalida");
      case "42501":
        throw new AccesoError("permiso_denegado");
      default:
    }
  }
  throw e;
}

/**
 * Atención de mensajes (spec 024, D-5 a D-8, U-1, U-3; CA-4 a CA-7, CA-12). Marcar y deshacer pasan SIEMPRE por la función acotada
 * de 0060 (única que cambia el estado y deja el evento y la auditoría, sin el texto del comentario). Aquí solo se valida la entrada,
 * se decide la visibilidad con el mismo alcance del resto de rutas, se traducen sus errores y se reintenta una vez un interbloqueo.
 * Nunca llama a SUNAT, no encola nada ni toca notificaciones; el comentario no se registra en ningún log.
 */
@Injectable()
export class AtencionBuzonService {
  constructor(@Inject(DB) private readonly db: Pick<ContappDb, "withTenant">) {}

  /** `POST /clientes/:clienteId/buzon/mensajes/:mensajeId/atencion`: marcar o deshacer un mensaje del cliente. */
  async atender(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteCrudo: string,
    mensajeCrudo: string,
    cuerpo: unknown,
  ): Promise<ResultadoAtender> {
    const b = atenderMensajeBodySchema.safeParse(cuerpo);
    if (!b.success) throw new AccesoError("solicitud_invalida");
    const clienteId = idDe(clienteCrudo).toLowerCase();
    const mensajeId = idDe(mensajeCrudo).toLowerCase();
    const ctx = contextoDe(sesion);
    try {
      return await conReintentoUnico(() =>
        this.db.withTenant(ctx, async (tx): Promise<ResultadoAtender> => {
          await exigirCliente(tx, clienteId, alcance, false);
          const [r] = await aplicarAtencionBuzon(tx, {
            accion: b.data.accion,
            mensajes: [mensajeId],
            clienteId,
            ...(b.data.comentario === undefined ? {} : { comentario: b.data.comentario }),
          });
          const detalle = await detalleAtencion(tx, mensajeId);
          if (r === undefined || detalle === null) throw new AccesoError("no_encontrado");
          return { cambiada: !r.aplicado, atencion: aAtencionDetalle(detalle) };
        }),
      );
    } catch (e) {
      return traducir(e);
    }
  }

  /**
   * `POST /buzon/atencion`: marca varios mensajes (solo marcar, U-3). Todo o nada ante un id no visible (404), un crítico sin
   * comentario (400) o un cliente archivado (409); los ya atendidos no son error: salen en `omitidos`.
   */
  async atenderLote(sesion: SesionResuelta, alcance: Alcance, cuerpo: unknown): Promise<RespuestaLote> {
    const b = atenderLoteBodySchema.safeParse(cuerpo);
    if (!b.success) throw new AccesoError("solicitud_invalida");
    const ids = b.data.mensajes.map((i) => i.toLowerCase());
    const ctx = contextoDe(sesion);
    try {
      return await conReintentoUnico(() =>
        this.db.withTenant(ctx, async (tx): Promise<RespuestaLote> => {
          await this.exigirVisibles(tx, alcance, ids);
          const r = await aplicarAtencionBuzon(tx, {
            accion: "marcar",
            mensajes: ids,
            ...(b.data.comentario === undefined ? {} : { comentario: b.data.comentario }),
          });
          const aplicado = new Map(r.map((f) => [f.mensajeId.toLowerCase(), f.aplicado]));
          return {
            atendidos: ids.filter((i) => aplicado.get(i) === true),
            omitidos: ids.filter((i) => aplicado.get(i) !== true),
          };
        }),
      );
    } catch (e) {
      return traducir(e);
    }
  }

  /**
   * La función acotada no aplica alcance (plan 024, «Visibilidad»): aquí, en la misma transacción, todos los ids deben existir en el
   * estudio y ser de clientes visibles con `filtroAlcance` (vía `clienteVisible`). Inexistente, de otro estudio o de un cliente no
   * asignado dan el mismo 404, sin decir cuál falló.
   */
  private async exigirVisibles(tx: Tx, alcance: Alcance, ids: string[]): Promise<void> {
    const { rows } = await tx.query<{ cliente_id: string; n: number }>(SQL_CLIENTES_DE_MENSAJES, [ids]);
    if (rows.reduce((suma, f) => suma + f.n, 0) !== ids.length) throw new AccesoError("no_encontrado");
    for (const f of rows) {
      if (!(await clienteVisible(tx, f.cliente_id, alcance))) throw new AccesoError("no_encontrado");
    }
  }
}

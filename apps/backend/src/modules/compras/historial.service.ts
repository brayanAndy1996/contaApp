import { Inject, Injectable } from "@nestjs/common";
import { deshacer, leerCompraIdsDeOperacion, rehacer, type Alcance, type ContappDb } from "@contapp/db";
import type { DeshacerRespuesta } from "@contapp/shared";
import type { SesionResuelta } from "../auth/auth.service.js";
import { DB } from "../auth/inyeccion.js";
import { contextoDe } from "../clientes/contexto.js";
import { periodoDe } from "./apoyo.js";
import { aErrorHttp, entornoDeReglas, exigirEscritura } from "./escritura.js";

/**
 * Deshacer y rehacer (spec 014, D-14, DU-3): la pila es del usuario, por cliente y periodo, y vive en la BD. Cumplen el bloqueo
 * por estado de D-9. `fila_cambiada` (409, con los ids) si otra persona cambió una fila; `nada_que_deshacer` y
 * `nada_que_rehacer` (409) si no hay qué tratar. Nada se borra: son versiones nuevas con la acción `deshacer` o `rehacer`.
 */
@Injectable()
export class HistorialComprasService {
  constructor(@Inject(DB) private readonly db: Pick<ContappDb, "withTenant">) {}

  deshacer(
    sesion: SesionResuelta,
    alcance: Alcance,
    permisos: ReadonlySet<string>,
    clienteId: string,
    periodo: string,
  ): Promise<DeshacerRespuesta> {
    return this.revertir(sesion, alcance, permisos, clienteId, periodo, deshacer);
  }

  rehacer(
    sesion: SesionResuelta,
    alcance: Alcance,
    permisos: ReadonlySet<string>,
    clienteId: string,
    periodo: string,
  ): Promise<DeshacerRespuesta> {
    return this.revertir(sesion, alcance, permisos, clienteId, periodo, rehacer);
  }

  private async revertir(
    sesion: SesionResuelta,
    alcance: Alcance,
    permisos: ReadonlySet<string>,
    clienteId: string,
    periodoCrudo: string,
    sentido: typeof deshacer,
  ): Promise<DeshacerRespuesta> {
    const periodo = periodoDe(periodoCrudo);
    const ctx = contextoDe(sesion);
    return this.db.withTenant(ctx, async (tx) => {
      await exigirEscritura(tx, alcance, permisos, clienteId, periodo, { crear: true, archivado: true });
      const entorno = await entornoDeReglas(tx, clienteId, periodo);
      try {
        const r = await sentido(tx, { clienteId, periodo, usuarioId: ctx.userId }, { evaluar: entorno.evaluar });
        return { operacionId: r.operacionId, filas: await leerCompraIdsDeOperacion(tx, r.operacionId) };
      } catch (e) {
        throw aErrorHttp(e);
      }
    });
  }
}

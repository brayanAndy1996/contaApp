import { Inject, Injectable } from "@nestjs/common";
import { leerDetalleXml, leerHistorialProveedor, type Alcance, type ContappDb } from "@contapp/db";
import { detalleLupaSchema, type DetalleLupa } from "@contapp/shared";
import { AccesoError } from "../acceso/errores.js";
import type { SesionResuelta } from "../auth/auth.service.js";
import { DB } from "../auth/inyeccion.js";
import { contextoDe } from "../clientes/contexto.js";
import { exigirCliente, idDe, periodoDe } from "./apoyo.js";
import { aDetalleLupa } from "./detalle.js";

/**
 * Detalle de la lupa (spec 016, D-8, CA-18): solo lectura. No encola, no escribe y no re-parsea el XML: lee el `detalle` jsonb
 * guardado. Una compra de otro cliente, periodo o estudio, inexistente o mal formada da el mismo 404.
 */
@Injectable()
export class DetalleComprasService {
  constructor(@Inject(DB) private readonly db: Pick<ContappDb, "withTenant">) {}

  async detalle(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteId: string,
    periodoCrudo: string,
    compraCruda: string,
  ): Promise<DetalleLupa> {
    const periodo = periodoDe(periodoCrudo);
    const compraId = idDe(compraCruda);
    const { leido, historial } = await this.db.withTenant(contextoDe(sesion), async (tx) => {
      await exigirCliente(tx, clienteId, alcance, false);
      const leido = await leerDetalleXml(tx, clienteId, periodo, compraId);
      if (leido === null) throw new AccesoError("no_encontrado");
      const historial = await leerHistorialProveedor(tx, clienteId, periodo, {
        docTipo: leido.compra.docTipo,
        docNumero: leido.compra.docNumero,
      });
      return { leido, historial };
    });
    // El esquema es la última puerta: descarta toda clave que el DTO no declara (ruta de storage, hash, tenant) aunque la lectura
    // de `packages/db` las traiga. Un DTO que no lo cumple es un defecto de programa (500 sin detalle), no una respuesta rara.
    return detalleLupaSchema.parse(aDetalleLupa(leido, historial));
  }
}

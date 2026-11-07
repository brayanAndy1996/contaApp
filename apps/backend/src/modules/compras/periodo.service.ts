import { Inject, Injectable } from "@nestjs/common";
import { fijarEstadoPeriodo, type Alcance, type ContappDb, type EstadoPeriodoCompra, type EstadoPeriodoCompras } from "@contapp/db";
import type { EstadoPeriodoRespuesta } from "@contapp/shared";
import type { SesionResuelta } from "../auth/auth.service.js";
import { DB } from "../auth/inyeccion.js";
import { contextoDe } from "../clientes/contexto.js";
import { AccesoError } from "../acceso/errores.js";
import { exigirCliente, periodoDe } from "./apoyo.js";
import { ComprasError } from "./errores.js";

const PERMISO_APROBAR_GENERAR = "sire.aprobar_generar";

/** `{ estado, por, en }`: quién y cuándo marcó el periodo (`null` mientras nadie lo haya marcado). */
export function aRespuestaEstado(e: EstadoPeriodoCompra): EstadoPeriodoRespuesta {
  return { estado: e.estado, por: e.marcadoPor, en: e.marcadoEn === null ? null : e.marcadoEn.toISOString() };
}

/**
 * Estado del periodo (spec 014, D-9, DU-4): marcar `revisado` (`sire.clasificar`, solo desde `abierto`) y reabrir
 * (`sire.aprobar_generar`, desde `revisado` o `generado`). Ambos son compare-and-set sobre `compra_periodo`: si el estado ya no
 * es el esperado, 409 `estado_invalido` y no cambia nada. `generado` lo fija 012b. No crean versiones ni entran en deshacer.
 */
@Injectable()
export class PeriodoComprasService {
  constructor(@Inject(DB) private readonly db: Pick<ContappDb, "withTenant">) {}

  revisar(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteId: string,
    periodo: string,
  ): Promise<EstadoPeriodoRespuesta> {
    return this.cambiar(sesion, alcance, clienteId, periodo, ["abierto"], "revisado");
  }

  reabrir(
    sesion: SesionResuelta,
    alcance: Alcance,
    permisos: ReadonlySet<string>,
    clienteId: string,
    periodo: string,
  ): Promise<EstadoPeriodoRespuesta> {
    if (!permisos.has(PERMISO_APROBAR_GENERAR)) throw new AccesoError("permiso_denegado");
    return this.cambiar(sesion, alcance, clienteId, periodo, ["revisado", "generado"], "abierto");
  }

  private async cambiar(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteId: string,
    periodoCrudo: string,
    desde: readonly EstadoPeriodoCompras[],
    hacia: EstadoPeriodoCompras,
  ): Promise<EstadoPeriodoRespuesta> {
    const periodo = periodoDe(periodoCrudo);
    const ctx = contextoDe(sesion);
    return this.db.withTenant(ctx, async (tx) => {
      await exigirCliente(tx, clienteId, alcance, true);
      for (const origen of desde) {
        const nuevo = await fijarEstadoPeriodo(tx, clienteId, periodo, origen, hacia, ctx.userId);
        if (nuevo !== null) return aRespuestaEstado(nuevo);
      }
      throw new ComprasError("estado_invalido");
    });
  }
}

import { Inject, Injectable } from "@nestjs/common";
import { fijarEstadoPeriodoVentas, type Alcance, type ContappDb, type EstadoPeriodoVenta, type EstadoPeriodoVentas, type Tx } from "@contapp/db";
import type { EstadoPeriodoRespuesta, ReabrirPeriodo } from "@contapp/shared";
import { AccesoError } from "../acceso/errores.js";
import type { SesionResuelta } from "../auth/auth.service.js";
import { DB } from "../auth/inyeccion.js";
import { contextoDe } from "../clientes/contexto.js";
import { autoresDe, autorDe } from "../compras/autor.js";
import { exigirCliente, periodoSinFuturoDe } from "./apoyo.js";
import { VentasError } from "./errores.js";

const PERMISO_APROBAR_GENERAR = "sire.aprobar_generar";

/** `{ estado, por, autor, en }`: quién (id y autor con nombre) y cuándo marcó el periodo (`null` mientras nadie lo haya marcado). */
export async function aRespuestaEstado(tx: Tx, e: EstadoPeriodoVenta): Promise<EstadoPeriodoRespuesta> {
  const autores = await autoresDe(tx, [e.marcadoPor]);
  return {
    estado: e.estado,
    por: e.marcadoPor,
    autor: autorDe(autores, e.marcadoPor),
    en: e.marcadoEn === null ? null : e.marcadoEn.toISOString(),
  };
}

/**
 * Estado del periodo de ventas (spec 012b, P-1, D5; modelo: `PeriodoComprasService` de 014): marcar `revisado`
 * (`sire.clasificar`, solo desde `abierto`) y reabrir (`sire.aprobar_generar`, solo desde el estado que vio quien lo pide,
 * `revisado` o `generado`). Ambos son compare-and-set sobre `venta_periodo`: si el estado ya no es el esperado, 409
 * `estado_invalido` y no cambia nada. `generado` lo fija el worker. No toman el advisory del libro (el `FOR UPDATE` de la fila
 * los serializa con las escrituras, que la leen `FOR SHARE`), no crean versiones ni tocan las ventas.
 */
@Injectable()
export class EstadoVentasService {
  constructor(@Inject(DB) private readonly db: Pick<ContappDb, "withTenant">) {}

  revisar(sesion: SesionResuelta, alcance: Alcance, clienteId: string, periodo: string): Promise<EstadoPeriodoRespuesta> {
    return this.cambiar(sesion, alcance, clienteId, periodo, ["abierto"], "revisado");
  }

  reabrir(
    sesion: SesionResuelta,
    alcance: Alcance,
    permisos: ReadonlySet<string>,
    clienteId: string,
    periodo: string,
    estadoVisto: ReabrirPeriodo["estadoVisto"],
  ): Promise<EstadoPeriodoRespuesta> {
    if (!permisos.has(PERMISO_APROBAR_GENERAR)) throw new AccesoError("permiso_denegado");
    return this.cambiar(sesion, alcance, clienteId, periodo, [estadoVisto], "abierto");
  }

  private async cambiar(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteId: string,
    periodoCrudo: string,
    desde: readonly EstadoPeriodoVentas[],
    hacia: EstadoPeriodoVentas,
  ): Promise<EstadoPeriodoRespuesta> {
    const periodo = periodoSinFuturoDe(periodoCrudo);
    const ctx = contextoDe(sesion);
    return this.db.withTenant(ctx, async (tx) => {
      await exigirCliente(tx, clienteId, alcance, true);
      for (const origen of desde) {
        const nuevo = await fijarEstadoPeriodoVentas(tx, clienteId, periodo, origen, hacia, ctx.userId);
        if (nuevo !== null) return aRespuestaEstado(tx, nuevo);
      }
      throw new VentasError("estado_invalido");
    });
  }
}

import { Inject, Injectable } from "@nestjs/common";
import {
  leerDeclaraciones,
  leerHistorialMes,
  leerManuales,
  leerTotalesVentasProrrata,
  leerUltimaObtencion,
  leerUsada,
  listarPropuestas,
  type Alcance,
  type ContappDb,
} from "@contapp/db";
import { MontoFueraDeRangoError, ventanaProrrata } from "@contapp/domain";
import type { HistorialMesVista, ProrrataVista } from "@contapp/shared";
import type { SesionResuelta } from "../auth/auth.service.js";
import { DB } from "../auth/inyeccion.js";
import { contextoDe } from "../clientes/contexto.js";
import { ResumenComprasService } from "../compras/resumen.service.js";
import { ComprasError } from "../compras/errores.js";
import { exigirCliente, periodoCalculable, periodoDeRuta } from "./apoyo.js";
import { armarHistorial, armarVista, type DatosProrrata } from "./vistas.js";

// Fecha de la obtención de cada presentación del historial (el repositorio entrega solo `obtencionId`): consulta estática y
// parametrizada, con la RLS del estudio; el cliente va en la consulta como en el resto de lecturas.
const SQL_OBTENCIONES = "select id, obtenida_en from prorrata_obtencion where cliente_id = $1 and id = any($2::uuid[])";

/**
 * Lectura de la prorrata (spec 026, R-1 a R-8; CA-1, CA-3 a CA-6, CA-11). Una transacción `withTenant` en foto lee declaraciones,
 * manuales, totales de ventas (agregados en SQL: 12 × 5.000 filas no viajan una a una), última obtención, prorrata usada y si hay
 * propuesta de compras de M; después, SOLO si el IGV se puede estimar, los IGV vigentes de las compras de M con `ResumenComprasService`
 * de 014 (las mismas filas y conversión que su resumen, en esta misma transacción) y el dominio arma meses, coeficiente, IGV y
 * diferencia. No escribe nada y se permite con el cliente archivado (D-5).
 */
@Injectable()
export class LecturaProrrataService {
  constructor(
    @Inject(DB) private readonly db: Pick<ContappDb, "withTenant">,
    @Inject(ResumenComprasService) private readonly compras: ResumenComprasService,
  ) {}

  /** `ProrrataVista` de M (por omisión el mes anterior en hora de Lima). */
  async vista(sesion: SesionResuelta, alcance: Alcance, clienteCrudo: string, periodoCrudo: unknown): Promise<ProrrataVista> {
    const periodo = periodoCalculable(periodoCrudo, Date.now(), true);
    const clienteId = clienteCrudo.toLowerCase();
    const ventana = ventanaProrrata(periodo);
    return this.db.withTenant({ ...contextoDe(sesion), foto: true }, async (tx) => {
      await exigirCliente(tx, clienteId, alcance, false);
      const datos: DatosProrrata = {
        periodo,
        ventana,
        declaraciones: await leerDeclaraciones(tx, clienteId, ventana),
        manuales: await leerManuales(tx, clienteId, ventana),
        totales: await leerTotalesVentasProrrata(tx, clienteId, ventana),
        obtencion: await leerUltimaObtencion(tx, clienteId, periodo),
        usada: await leerUsada(tx, clienteId, periodo),
        comprasCargadas: (await listarPropuestas(tx, clienteId, periodo, "compras")).length > 0,
      };
      try {
        return await armarVista(datos, () => this.compras.igvVigente(tx, clienteId, periodo));
      } catch (e) {
        // Meses y ventana fuera de NUMERIC(14,2) ya no llegan aquí: son el coeficiente `montos_fuera_de_rango` con la tabla (H-026-2-3,
        // H-026-2-4). Solo queda el IGV de las ventas o compras de M con un coeficiente calculado: 422 controlado, no 500 (como 014).
        if (e instanceof MontoFueraDeRangoError) throw new ComprasError("resumen_fuera_de_rango");
        throw e;
      }
    });
  }

  /** Todas las presentaciones y todas las versiones del manual de un mes. */
  async historial(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteCrudo: string,
    periodoCrudo: string,
  ): Promise<HistorialMesVista> {
    const periodo = periodoDeRuta(periodoCrudo);
    const clienteId = clienteCrudo.toLowerCase();
    return this.db.withTenant({ ...contextoDe(sesion), foto: true }, async (tx) => {
      await exigirCliente(tx, clienteId, alcance, false);
      const { declaraciones, manual } = await leerHistorialMes(tx, clienteId, periodo);
      const ids = [...new Set(declaraciones.map((d) => d.obtencionId))];
      const fechas = new Map<string, Date>();
      if (ids.length > 0) {
        const { rows } = await tx.query<{ id: string; obtenida_en: Date }>(SQL_OBTENCIONES, [clienteId, ids]);
        for (const f of rows) fechas.set(f.id, f.obtenida_en);
      }
      return armarHistorial(declaraciones, manual, fechas);
    });
  }
}

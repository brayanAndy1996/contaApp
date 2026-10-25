// Cambio de destino de la adquisición (plan 010, Decisiones: Movimientos).
import { Money, MovimientoInvalidoError } from "../dinero/index";
import { DESTINOS, PAR_DESTINO, esDestino } from "./columnas";
import type { Destino } from "./columnas";
import { copiarColumnas, montosDesdeColumnas } from "./montos-comprobante";
import type { MontosComprobante } from "./montos-comprobante";

/**
 * Suma los tres BI en el BI de `d` y los tres IGV en el IGV de `d`; los demás destinos
 * quedan en 0.00 y el total no cambia. `consolidados` lista (en orden DG, DGNG, DNG) los
 * otros destinos que tenían BI o IGV distinto de cero. Mismo destino → sin cambios y [].
 */
export function cambiarDestino(
  m: MontosComprobante,
  d: Destino,
): { montos: MontosComprobante; consolidados: Destino[] } {
  if (!esDestino(d)) throw new MovimientoInvalidoError();
  const consolidados: Destino[] = [];
  const columnas = copiarColumnas(m);
  const bis: Money[] = [];
  const igvs: Money[] = [];
  for (const o of DESTINOS) {
    const { bi, igv } = PAR_DESTINO[o];
    bis.push(columnas[bi]);
    igvs.push(columnas[igv]);
    if (o === d) continue;
    if (!columnas[bi].esCero() || !columnas[igv].esCero()) consolidados.push(o);
    columnas[bi] = Money.cero(m.moneda);
    columnas[igv] = Money.cero(m.moneda);
  }
  if (consolidados.length === 0) return { montos: m, consolidados };
  columnas[PAR_DESTINO[d].bi] = Money.suma(bis, m.moneda);
  columnas[PAR_DESTINO[d].igv] = Money.suma(igvs, m.moneda);
  return { montos: montosDesdeColumnas(m.moneda, columnas, m.total), consolidados };
}

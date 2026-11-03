// R-MIX (RF-082; spec D-3, D-7, CA-2–CA-4; plan 011, Decisiones: "Rango de R-MIX" y
// "Ratificación de contratos"). Rango y estimado siempre a 18 %; el 10 % solo valida el XML.
import type { ColumnaCompra } from "../comprobante/index";
import { TASA_IGV_10, TASA_IGV_18 } from "../dinero/index";
import type { Money } from "../dinero/index";
import { PARES_DESTINO, crearHallazgo } from "./entrada";
import type { FilaInterna, XmlInterno } from "./entrada";
import {
  SUFIJO_MIX_RANGO_VACIO,
  SUFIJO_MIX_VARIOS_DESTINOS,
  mix,
  sufijoMixExacto,
  sufijoMixGravadoFuera,
  sufijoMixIgvDistinto,
} from "./explicaciones";
import { enRango, rangoGravado } from "./rango";
import type { RangoGravado } from "./rango";
import type { DestinoEvaluado } from "./r-isc";
import type { Hallazgo, MontosParciales } from "./tipos";

/** El gravado del XML es exacto si cae en el rango a 18 % o, si no, en el rango a 10 % (D-7). */
function gravadoExacto(d: DestinoEvaluado, xml: XmlInterno, r18: RangoGravado): boolean {
  if (enRango(xml.gravado, r18)) return true;
  const r10 = rangoGravado(d.bi, d.igv, TASA_IGV_10);
  return r10 !== null && enRango(xml.gravado, r10);
}

/** Exacto (o null) y sufijo de la explicación según el XML. */
function conXml(
  d: DestinoEvaluado,
  xml: XmlInterno | null,
  r18: RangoGravado,
): { exacto: Money | null; sufijo: string } {
  if (xml === null) return { exacto: null, sufijo: "" };
  // Con varios destinos con BI ≠ 0 el gravado y el IGV del XML (totales) no se asignan a ninguno.
  if (!d.unicoConBi) return { exacto: null, sufijo: SUFIJO_MIX_VARIOS_DESTINOS };
  if (!xml.igv.igual(d.igv)) return { exacto: null, sufijo: sufijoMixIgvDistinto(xml.igv) };
  if (gravadoExacto(d, xml, r18)) return { exacto: xml.gravado, sufijo: sufijoMixExacto(xml.gravado) };
  return { exacto: null, sufijo: sufijoMixGravadoFuera(xml.gravado) };
}

/**
 * BI e IGV del destino; con XML también las BI de los otros destinos, porque el exacto exige
 * "único destino con BI ≠ 0" (T15, R2a-3 = R2b-1: si cambian, la sugerencia es obsoleta).
 */
function lecturas(fila: FilaInterna, d: DestinoEvaluado): MontosParciales {
  const l: Partial<Record<ColumnaCompra, Money>> = { [d.par.bi]: d.bi, [d.par.igv]: d.igv };
  if (fila.xml !== null) {
    for (const p of PARES_DESTINO) if (p.destino !== d.par.destino) l[p.bi] = fila.montos.obtener(p.bi);
  }
  return l;
}

/** Destino con IGV ≠ 0 que no cuadra a 18 % ni a 10 %. */
export function evaluarMix(fila: FilaInterna, d: DestinoEvaluado): Hallazgo {
  const base = {
    filaId: fila.id,
    regla: "R-MIX" as const,
    destino: d.par.destino,
    lecturas: lecturas(fila, d),
  };
  const r18 = rangoGravado(d.bi, d.igv, TASA_IGV_18);
  if (r18 === null) {
    return crearHallazgo({
      ...base,
      explicacion: mix(d.igv, d.bi) + SUFIJO_MIX_RANGO_VACIO,
      sugerencia: null,
      requiereConfirmacion: true,
      dato: null,
    });
  }
  const { exacto, sufijo } = conXml(d, fila.xml, r18);
  return crearHallazgo({
    ...base,
    explicacion: mix(d.igv, d.bi) + sufijo,
    sugerencia: {
      tipo: "separar",
      columnaBi: d.par.bi,
      min: r18.min,
      max: r18.max,
      estimado: r18.estimado,
      exacto,
    },
    requiereConfirmacion: exacto === null,
    dato: exacto === null ? "gravado" : null,
  });
}

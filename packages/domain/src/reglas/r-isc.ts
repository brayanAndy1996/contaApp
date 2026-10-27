// R-ISC (RF-081; spec D-1, D-2; plan 011, Decisiones: "R-ISC" y "Ratificación de contratos").
import type { Money } from "../dinero/index";
import { crearHallazgo } from "./entrada";
import type { FilaInterna, ParDestino } from "./entrada";
import {
  ISC_XML_EXACTO,
  MARCA_ISC_SIN_XML,
  iscSinXml,
  iscXmlNoCabe,
  iscXmlSinIsc,
  marcaIscConXml,
} from "./explicaciones";
import type { Hallazgo, Sugerencia } from "./tipos";

/** Destino evaluado: su par de columnas, BI e IGV leídos y si es el único con BI ≠ 0. */
export interface DestinoEvaluado {
  readonly par: ParDestino;
  readonly bi: Money;
  readonly igv: Money;
  readonly unicoConBi: boolean;
}

/**
 * Monto a mover según el XML: `xml.isc − isc` de la fila, desde la BI del único destino con
 * BI ≠ 0, del mismo signo que la BI y con |monto| ≤ |BI|; si no cabe, null.
 */
function iscDelXml(fila: FilaInterna, d: DestinoEvaluado, iscXml: Money): Money | null {
  const monto = iscXml.restar(fila.montos.obtener("isc"));
  const cabe =
    d.unicoConBi &&
    !monto.esCero() &&
    monto.esNegativo() === d.bi.esNegativo() &&
    monto.abs().comparar(d.bi.abs()) <= 0;
  return cabe ? monto : null;
}

function hallazgo(
  fila: FilaInterna,
  d: DestinoEvaluado,
  explicacion: string,
  monto: Money | null,
  respaldaXml: boolean,
): Hallazgo {
  const sugerencia: Sugerencia | null =
    monto === null ? null : { tipo: "mover", origen: d.par.bi, destino: "isc", monto };
  return crearHallazgo({
    filaId: fila.id,
    regla: "R-ISC",
    destino: d.par.destino,
    explicacion,
    sugerencia,
    requiereConfirmacion: !(respaldaXml && sugerencia !== null),
    dato: null,
    lecturas: { [d.par.bi]: d.bi, [d.par.igv]: d.igv },
  });
}

/** Destino con BI ≠ 0 e IGV = 0 (D-1). */
export function evaluarIscIgvCero(fila: FilaInterna, d: DestinoEvaluado): Hallazgo {
  const xml = fila.xml;
  if (xml === null) return hallazgo(fila, d, iscSinXml(d.bi), d.bi, false);
  if (xml.isc.esCero()) return hallazgo(fila, d, iscXmlSinIsc(d.bi), null, true);
  const monto = iscDelXml(fila, d, xml.isc);
  if (monto === null) return hallazgo(fila, d, iscXmlNoCabe(d.bi, xml.isc), null, true);
  return hallazgo(fila, d, ISC_XML_EXACTO, monto, true);
}

/**
 * Proveedor marcado como emisor de ISC con IGV ≠ 0 que cuadra (D-2). Con XML válido la
 * explicación dice el ISC del XML (también 0.00, sin sugerencia: el XML no lo respalda).
 */
export function evaluarIscMarcado(fila: FilaInterna, d: DestinoEvaluado): Hallazgo {
  const xml = fila.xml;
  if (xml === null) return hallazgo(fila, d, MARCA_ISC_SIN_XML, null, false);
  if (xml.isc.esCero()) return hallazgo(fila, d, marcaIscConXml(xml.isc), null, true);
  return hallazgo(fila, d, marcaIscConXml(xml.isc), iscDelXml(fila, d, xml.isc), true);
}

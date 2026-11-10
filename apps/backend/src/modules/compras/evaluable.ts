// Puente entre la fila que entrega `packages/db` (`CompraConXml`, el `detalle` del XML como jsonb opaco) y la que evalúa el
// dominio (`CompraEvaluable`, con el `DetalleXml` tipado). El jsonb lo escribió nuestro parser (`leerUbl`), no el usuario.
import type { CompraConXml } from "@contapp/db";
import type { CompraEvaluable, DetalleXml } from "@contapp/domain";

export function aEvaluable(c: CompraConXml): CompraEvaluable {
  const { xml, ...resto } = c;
  return xml === null ? resto : { ...resto, xml: { origen: xml.origen, detalle: xml.detalle as DetalleXml } };
}

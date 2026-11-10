// Evaluación de reglas de la descarga de compras y de la re-evaluación con XML (spec 014 D-4, spec 016 D-5, P-4). La conversión de
// `evaluarReglas` de 011 a la forma que se guarda en `compra_hallazgo` vive en `packages/domain` (`crearEvaluarCompras`): el
// backend re-evalúa con la MISMA función. Aquí solo se adapta la fila que entrega `packages/db` (`CompraConXml`: XML `null` sin
// XML y `detalle` jsonb opaco) a la que evalúa el dominio (`xml` ausente sin XML y `DetalleXml` tipado). El jsonb lo escribió
// nuestro parser (`leerUbl`), no el usuario.
import type { CompraConXml, EvaluarCompra } from "@contapp/db";
import {
  crearEvaluarCompras as crearEvaluarDominio,
  type CompraEvaluable,
  type DetalleXml,
} from "@contapp/domain";

const aEvaluable = (c: CompraConXml): CompraEvaluable => {
  const { xml, ...resto } = c;
  return xml === null
    ? resto
    : { ...resto, xml: { origen: xml.origen, detalle: xml.detalle as DetalleXml } };
};

/** `xmlSimuladoEnReglas` es `XML_SIMULADO_EN_REGLAS` (P-4): apagada por defecto. */
export function crearEvaluarCompras(
  proveedoresConocidos: readonly { tipo: string; numero: string }[],
  opciones: { xmlSimuladoEnReglas: boolean } = { xmlSimuladoEnReglas: false },
): EvaluarCompra {
  const evaluar = crearEvaluarDominio(proveedoresConocidos, opciones);
  return (fila) => evaluar(aEvaluable(fila));
}

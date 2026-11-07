// Evaluación de reglas de la descarga de compras (spec 014, D-4, plan «Worker»). La conversión de `evaluarReglas` de 011 a la
// forma que se guarda en `compra_hallazgo` vive en `packages/domain` (`crearEvaluarCompras`): el backend re-evalúa cada versión
// nueva con la MISMA función, así que aquí solo se reexporta para el persistidor.
export { crearEvaluarCompras } from "@contapp/domain";

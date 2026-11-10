// API pública de compras/ (plan 014, Contratos: Dominio). Puro, sin IO; los montos son Money.
export { claveComprobante } from "./clave";
export { aplicarEdicion } from "./edicion";
export type { CambiosMontos, CeldaCuadre, CuadreEdicion, ResultadoEdicion } from "./edicion";
export { resumirCompras } from "./resumen";
export type { Casilleros, CompraResumen, GrupoIgv, ResumenCompras } from "./resumen";
export { aFilaReemplazo } from "./fila-reemplazo";
export type { CompraParaReemplazo } from "./fila-reemplazo";
export { EstadoPeriodoInvalidoError, puedeEscribir } from "./bloqueo";
export type { EstadoPeriodo, ResultadoEscritura } from "./bloqueo";
export { sugerenciaEsMasiva } from "./masivas";
export { EXPLICACION_GENERICA, detallarHallazgo } from "./hallazgo-vista";
export type { DetalleHallazgo, HallazgoGuardado } from "./hallazgo-vista";
export { crearEvaluarCompras } from "./evaluar";
export type { CompraEvaluable, HallazgoJson, OpcionesEvaluar, OrigenXml, XmlEvaluable } from "./evaluar";
export { planificarObtencionXml } from "./obtencion";
export type { EstadoObtencion, FilaPorObtener } from "./obtencion";
export { aceptarSugerenciaGuardada } from "./aceptar";
export type { DatoAceptar, EntradaAceptar, RechazoAceptar, ResultadoAceptar } from "./aceptar";

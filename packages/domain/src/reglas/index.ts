// API pública de reglas/ (plan 011, Contratos; 021). Solo tipos, ORDEN_REGLAS, errores, evaluarReglas, la aplicación,
// R-HIS y el catálogo del motor; entrada, explicaciones, rango y cada regla de 011 son internos.
export * from "./tipos";
export * from "./errores";
export { evaluarReglas } from "./motor";
export { aplicarSugerencia, aplicarMasivo } from "./aplicar";
export { planificarHistorial } from "./r-his";
export type { PlanHistorial } from "./r-his";
export { CATALOGO_REGLAS_MOTOR, esRucAportable } from "./catalogo";
export type { ReglaMotorCatalogo } from "./catalogo";

// API pública de reglas/ (plan 011, Contratos). Solo tipos, ORDEN_REGLAS, errores,
// evaluarReglas y la aplicación; entrada, explicaciones, rango y cada regla son internos.
export * from "./tipos";
export * from "./errores";
export { evaluarReglas } from "./motor";
export { aplicarSugerencia, aplicarMasivo } from "./aplicar";

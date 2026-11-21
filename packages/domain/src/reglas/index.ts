// API pública de reglas/ (plan 011, Contratos; 021; 025). Solo tipos, ORDEN_REGLAS, errores, evaluarReglas, la aplicación,
// R-HIS, el catálogo del motor, la deducción del historial y el criterio del modo estándar; entrada, explicaciones, rango y cada regla de 011 son internos.
export * from "./tipos";
export * from "./errores";
export { evaluarReglas } from "./motor";
export { aplicarSugerencia, aplicarMasivo } from "./aplicar";
export { planificarHistorial } from "./r-his";
export type { PlanHistorial } from "./r-his";
export { CATALOGO_REGLAS_MOTOR, esRucAportable } from "./catalogo";
export type { ReglaMotorCatalogo } from "./catalogo";
export { aprenderDeHistorial } from "./aprender";
export type { CandidataDeducida, ConteosCandidata, FilaHistorial, ResultadoAprendizaje } from "./aprender";
export { cumpleModoEstandar } from "./r-std";
export type { PerfilCliente } from "./r-std";

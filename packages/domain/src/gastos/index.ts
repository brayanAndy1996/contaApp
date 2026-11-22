// API pública de gastos/ (spec 027, plan Contratos: domain). Solo estos 8 valores entran en el índice del paquete (lista cerrada de
// `ronda2b.adv.spec.ts`); CIIU, matriz base, feriados, pesos y piezas internas no se exportan.
export { CATEGORIAS_GND } from "./categorias";
export type { CategoriaGnd } from "./categorias";
export { seccionCiiu } from "./ciiu";
export type { SeccionCiiu } from "./ciiu";
export { categoriasPermitidas } from "./matriz";
export type { AjusteCategorias } from "./matriz";
export { esDiaNoLaborable } from "./feriados";
export { crearDiccionarioEfectivo, validarContextoGastos } from "./contexto";
export type {
  CiiuProveedor,
  ContextoGastos,
  EntradaDiccionarioEfectivo,
  HistorialProveedor,
  PalabraDiccionario,
} from "./contexto";
export { puntuarGastoPersonal } from "./puntaje";
export type { CodigoSenal, EntradaGasto, ResultadoGasto, Senal } from "./puntaje";
export { proponerTerminos } from "./terminos";

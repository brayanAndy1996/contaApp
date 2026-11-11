// API pública de prevalidacion/ (plan 012, Contratos). entrada, estructura, aritmetica,
// duplicados y explicaciones son internos.
export type {
  EstadoFila,
  FilaReemplazo,
  CodigoError,
  ErrorPrevalidacion,
  CodigoAvisoPrevalidacion,
  AvisoPrevalidacion,
  ResultadoPrevalidacion,
  ContextoPrevalidacion,
  ResumenCambios,
  EstadoFilaVenta,
  FilaReemplazoVenta,
  ContextoPrevalidacionVentas,
  ResumenCambiosVentas,
} from "./tipos";
export { PrevalidacionError, EntradaPrevalidacionInvalidaError } from "./errores";
export { prevalidar } from "./prevalidar";
export { resumirCambios } from "./resumen";
export { erroresDeFilaVenta } from "./ventas";

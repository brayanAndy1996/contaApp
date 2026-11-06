// API pública de prevalidacion/ (plan 012, Contratos). entrada, estructura, aritmetica,
// duplicados y explicaciones son internos. resumirCambios llega con T10.
export type {
  EstadoFila,
  FilaReemplazo,
  CodigoError,
  ErrorPrevalidacion,
  CodigoAvisoPrevalidacion,
  AvisoPrevalidacion,
  ResultadoPrevalidacion,
  ContextoPrevalidacion,
} from "./tipos";
export { PrevalidacionError, EntradaPrevalidacionInvalidaError } from "./errores";
export { prevalidar } from "./prevalidar";

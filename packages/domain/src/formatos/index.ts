// API pública de formatos/ (plan 012, Contratos). provisional-rce es interno: se llega a él por
// REGISTRO_FORMATOS y seleccionarFormato.
export type {
  Libro,
  Codificacion,
  FinDeLinea,
  TipoCampo,
  CampoTxt,
  ComponentesNombre,
  NombresArchivo,
  FuncionNombre,
  FormatoTxt,
  CabeceraTxt,
  CodigoCampo,
  ErrorCampo,
} from "./tipos";
export * from "./errores";
export { RegistroFormatos, REGISTRO_FORMATOS, seleccionarFormato } from "./registro";
export { validarCampo } from "./campos";
export { validarNombreArchivo } from "./nombres";
export { generarTxt } from "./serializar";
export type { OpcionesGenerarTxt, ResultadoGenerarTxt } from "./serializar";

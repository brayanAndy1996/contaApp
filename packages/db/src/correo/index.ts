// STUB (spec 028, T4 rojo): lo reemplaza T10. Repositorio de correo (avisos y resumen diario).
export { CorreoRepoError } from "./errores";
export type { TxConsulta } from "./errores";
export { fijarPreferencias, leerPreferencias } from "./preferencias";
export type { PreferenciasAFijar, PreferenciasLeidas } from "./preferencias";
export {
  cerrarEnvio,
  leerAvisosEnvio,
  leerDestinatario,
  tomarEnvio,
} from "./envios";
export type {
  AvisoEnvio,
  CierreEnvio,
  Destinatario,
  EnvioTomado,
  EstadoCierre,
  MotivoEnvio,
  OrigenEnvio,
  TipoCorreo,
} from "./envios";
export { leerResumen } from "./resumen";
export type {
  ClienteResumen,
  EstadoPeriodoResumen,
  ParametrosResumen,
} from "./resumen";
export {
  cerrarResumenCorreo,
  crearResumenesCorreo,
  encolarAvisosCorreo,
  estudiosCorreo,
  purgarCorreo,
  renovarCicloCorreo,
  soltarCicloCorreo,
  tomarCicloCorreo,
} from "./ciclo";
export type { CicloCorreo, EstudioCorreo } from "./ciclo";
export { crearTokenBaja } from "./baja";

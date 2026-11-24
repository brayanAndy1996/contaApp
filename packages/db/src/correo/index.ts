// Repositorio de correo de la spec 028 (avisos y resumen diario): preferencias (backend), envíos, avisos, resumen, ciclo y token de baja
// (worker). La baja sin sesión está en `AuthRepo.aplicarBaja`.
export { CorreoRepoError } from "./errores";
export type { TxConsulta } from "./errores";
export { fijarPreferencias, leerPreferencias } from "./preferencias";
export type { PreferenciasAFijar, PreferenciasLeidas } from "./preferencias";
export {
  cerrarEnvio,
  leerAvisosEnvio,
  leerDestinatario,
  tomarEnvio,
  tomarEnvioParaEnviar,
} from "./envios";
export type {
  AvisoEnvio,
  CierreEnvio,
  Destinatario,
  EnvioTomado,
  EnvioTomadoParaEnviar,
  EstadoCierre,
  MotivoEnvio,
  OrigenEnvio,
  PlanCorreo,
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

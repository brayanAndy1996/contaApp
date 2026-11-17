// Repositorio del buzón SOL (spec 023): lectura (backend), escritura (worker), programación (funciones acotadas de 0055) y error.
export { BuzonRepoError } from "./errores";
export {
  bloquearEstadoBuzon,
  leerEstadoBuzon,
  listarMensajesBuzon,
  leerMensajeBuzon,
  leerAdjuntoBuzon,
} from "./lectura";
export { leerIdSunatBuzon } from "./id-sunat";
export { marcarSolicitudBuzon } from "./solicitud";
export type {
  AdjuntoBuzon,
  DetalleMensajeBuzon,
  EstadoBuzon,
  MensajeBuzonFila,
} from "./lectura";
export {
  actualizarConocidosBuzon,
  auditarBuzon,
  conocidosBuzon,
  guardarContenidoBuzon,
  guardarEstadoCapturaBuzon,
  insertarMensajeBuzon,
} from "./escritura";
export type {
  AccionAuditoriaBuzon,
  AdjuntoGuardarBuzon,
  EntradaMensajeBuzon,
} from "./escritura";
export {
  candidatosBuzon,
  elevarPrioridadBuzon,
  encolarBuzonProgramados,
} from "./programacion";
export type { CandidatoBuzon } from "./programacion";

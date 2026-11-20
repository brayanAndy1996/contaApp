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
export { fallaPorCredencialBuzon, marcarSolicitudBuzon } from "./solicitud";
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
  marcarRellenoBuzon,
  relojBdBuzon,
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
// Spec 024: bandeja, detalle de atención, indicador de nuevos y la función acotada de la atención (backend).
export { detalleAtencion, listarBandeja } from "./bandeja";
export type {
  AtencionVigente,
  DetalleAtencionBuzon,
  EstadoAtencionBuzon,
  EventoAtencionBuzon,
  FilaBandejaBuzon,
  FiltroAtencionBuzon,
  FiltrosBandejaBuzon,
  PosicionBandeja,
} from "./bandeja";
export { indicadorBuzon } from "./indicador";
export type { IndicadorBuzon } from "./indicador";
export { aplicarAtencionBuzon } from "./atencion";
export type { EntradaAtencionBuzon, ResultadoAtencionBuzon } from "./atencion";

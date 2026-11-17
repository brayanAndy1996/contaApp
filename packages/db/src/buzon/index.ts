// Repositorio del buzón SOL (spec 023). STUB de T4 (rojo): T11 lo implementa.
export { BuzonRepoError } from "./errores";
export {
  leerEstadoBuzon,
  listarMensajesBuzon,
  leerMensajeBuzon,
  leerAdjuntoBuzon,
} from "./lectura";
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

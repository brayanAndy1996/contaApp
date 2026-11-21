// STUB de la spec 025 (T4, rojo): T10 lo reemplaza. Repositorio de importaciones y candidatas del aprendizaje del historial.
export {
  AprendizajeRepoError,
  completarImportacion,
  fallarImportacion,
  fijarTrabajoImportacion,
  iniciarImportacion,
  leerImportacion,
  ultimaImportacion,
} from "./importacion";
export type {
  CandidataNueva,
  EstadoImportacion,
  ImportacionFila,
  ImportacionParaTrabajo,
  ResumenImportacion,
} from "./importacion";
export {
  activarCandidatas,
  descartarCandidatas,
  listarCandidatas,
  reemplazarCandidata,
} from "./candidatas";
export type {
  CandidataFila,
  ConflictoCandidata,
  EntradaActivar,
  EstadoCandidata,
  GrupoCandidatas,
  MotivoOmitida,
  PosicionCandidata,
} from "./candidatas";

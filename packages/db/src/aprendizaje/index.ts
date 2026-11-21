// Repositorio de importaciones y candidatas del aprendizaje del historial (spec 025). Escribe solo por las funciones acotadas de
// 0062; lee con la RLS del estudio. `packages/db` no depende de `domain`: la deducción la hace el worker con `aprenderDeHistorial`.
export {
  AprendizajeRepoError,
  completarImportacion,
  esUuidAprendizaje,
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

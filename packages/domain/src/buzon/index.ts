// API pública de buzon/ (spec 023, plan, Contratos: Dominio).
export { CATALOGO_BUZON } from "./catalogo";
export type {
  CategoriaBuzon,
  CategoriaCatalogo,
  CategoriaCritica,
  CatalogoBuzon,
  MotivoCritico,
} from "./catalogo";
export { normalizarAsunto } from "./normalizar";
export { clasificarMensaje } from "./clasificar";
export type { Clasificacion, EntradaClasificacion } from "./clasificar";
export {
  capturaVencida,
  desfaseCliente,
  seleccionarVencidos,
  ultimaFranja,
} from "./programacion";
export type { CandidatoCaptura } from "./programacion";
export {
  CURSOR_RELLENO,
  DIAS_AVISO_PRIMERA_SINCRONIZACION,
  MAX_PAGINAS_CAPTURA,
  MAX_PAGINAS_LECTURA,
  TOPE_MENSAJES_CAPTURA,
  debeAvisar,
  fechaMensaje,
  planificarCaptura,
} from "./captura";
export type {
  EstadoCaptura,
  MensajeListado,
  PaginaListado,
  PlanPagina,
} from "./captura";
export {
  TOPE_ADJUNTO_BYTES,
  TOPE_MENSAJE_BYTES,
  mimePorFirma,
  prepararAdjuntos,
  sanearNombreAdjunto,
} from "./adjunto";
export type {
  AdjuntoAGuardar,
  AdjuntoOmitido,
  AdjuntoRecibido,
  MotivoOmision,
} from "./adjunto";
export { TOPE_TEXTO_PLANO, htmlATextoPlano } from "./texto-plano";
export { idSunatValido, sanearTextoPortal } from "./saneo";

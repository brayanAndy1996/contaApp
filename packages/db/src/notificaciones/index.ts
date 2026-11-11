export {
  contarNoLeidas,
  listarNotificaciones,
  MAX_PAGINA_NOTIFICACIONES,
  TOPE_NO_LEIDAS,
} from "./lectura";
export type { FilaNotificacion, OpcionesNotificaciones, TipoNotificacion } from "./lectura";
export { destinatariosNuevos, marcarLeida, marcarLeidasHasta, purgarNotificaciones } from "./escritura";

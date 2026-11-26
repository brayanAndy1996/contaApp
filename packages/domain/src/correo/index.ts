// API pública de correo/ (spec 028, plan Contratos: domain). Solo estos 9 valores entran en el índice del paquete (lista cerrada de
// `ronda2b.adv.spec.ts`); la validación, la plantilla HTML y el error interno no se exportan.
export { escaparHtml, limpiarLinea } from "./texto";
export { diaLima, fechaHoraLima, periodoAnteriorLima } from "./tiempo";
export { armarCorreoAviso } from "./aviso";
export type { AvisoCorreo, EntradaCorreoAviso } from "./aviso";
export { armarCorreoResumen, resumenVacio } from "./resumen";
export type { ClienteResumen, EntradaCorreoResumen, EstadoPendiente } from "./resumen";
export { armarCorreoPendientes } from "./pendientes";
export type { EntradaCorreoPendientes } from "./pendientes";
export type { CorreoArmado, DiferidoCorreo, EnlacesCorreo, TipoAvisoCorreo } from "./comun";

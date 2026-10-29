export { createDb } from "./client";
export type { ContappDb, ContextoTenant, OpcionesDb, RolApp, Tx } from "./client";
export {
  ConfiguracionDbError,
  ContextoInvalidoError,
  WithTenantAnidadoError,
} from "./errores";
export {
  estadoCredenciales,
  guardarSobre,
  leerSobre,
  listarParaReenvolver,
  reemplazarDekEnvuelta,
  registrarDescifrado,
} from "./credenciales/repositorio";
export type {
  CredencialConSobre,
  EstadoCredencial,
  ResultadoDescifrado,
  SobreGuardado,
  TipoCredencial,
  TxConsulta,
} from "./credenciales/repositorio";
export { CredencialRepoError } from "./credenciales/errores";
export { crearAuthRepo } from "./auth/repositorio";
export type {
  AceptacionExistente,
  AceptacionNueva,
  AuthRepo,
  InvitacionVigente,
  LoginExitoArgs,
  LoginPreparado,
  RecuperacionConsumida,
  SesionEmitida,
  SesionValida,
  TipoLimite,
} from "./auth/repositorio";
export { AuthRepoError } from "./auth/errores";
// Spec 005: repositorios de acceso (todos con la `tx` de withTenant como primer argumento).
export { clienteVisible, filtroAlcance } from "./acceso/alcance";
export type { Alcance } from "./acceso/alcance";
export { leerCliente, listarClientes } from "./acceso/clientes";
export type { ClienteLeido, ClienteListado } from "./acceso/clientes";
export {
  bloquearMiembro,
  bloquearMiembros,
  cambiarRol,
  desactivar,
  listarMiembros,
  miembroActual,
  reactivar,
  ROLES_MIEMBRO,
} from "./acceso/miembros";
export type { MiembroActual, MiembroEstado, MiembroListado, RolMiembro } from "./acceso/miembros";
export {
  crearInvitacion,
  listarInvitaciones,
  reenviar,
  revocar,
  revocarPendientesDe,
} from "./acceso/invitaciones";
export type { InvitacionListada, NuevaInvitacion } from "./acceso/invitaciones";
export {
  asignar,
  asignarPorCliente,
  asignarPorUsuario,
  listarAsignaciones,
  retirar,
} from "./acceso/asignaciones";
export type {
  Anterior,
  AsignacionListada,
  Asignar,
  AsignarPorCliente,
  AsignarPorUsuario,
  TipoAsignacion,
} from "./acceso/asignaciones";
export { AccesoReglaError, AccesoRepoError } from "./acceso/errores";
export type { MotivoRegla } from "./acceso/errores";
export * as schema from "./schema";
export { auditoriaDescifrado, credencial } from "./schema/credenciales";
export { SEED } from "./seed/datos";
// Spec 008: trabajos (job_registro con la `tx` de withTenant; sistema.*, auth.purgar y config con la de withSistema).
export {
  contarPendientes,
  insertarTrabajo,
  leerTrabajo,
  listarTrabajos,
  posicion,
  purgarTerminados,
  revalidarEncolado,
  siguienteDisponible,
  siguientesDisponibles,
  trabajoVivoPorClave,
  transicionar,
} from "./trabajos/registro";
export type {
  CamposTransicion,
  GuardaTransicion,
  OpcionesInsertar,
  CanalTrabajo,
  ColaTrabajo,
  EstadoTrabajo,
  FiltrosTrabajos,
  MotivoTrabajo,
  NuevoTrabajo,
  PrioridadTrabajo,
  Revalidable,
  TrabajoFila,
  TrabajoVistaDb,
} from "./trabajos/registro";
export { leerConfig } from "./trabajos/config";
export type { ConfigCola } from "./trabajos/config";
export { estudiosConTrabajos, estudiosIds, purgarAuth } from "./trabajos/sistema";
export type { ConteosPurga, RetencionesAuth } from "./trabajos/sistema";
export { TrabajosRepoError } from "./trabajos/errores";
export { estadoCredencial, marcarCredencialInvalida } from "./credenciales/estado";
export type { EstadoDeCredencial, MotivoEstadoCredencial } from "./credenciales/estado";
export { configSistema, jobRegistro } from "./schema/trabajos";

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
  ConfirmacionNueva,
  DatosPlan,
  EstudioPlataforma,
  InvitacionVigente,
  LoginExitoArgs,
  LoginPreparado,
  PlanFila,
  RecuperacionConsumida,
  RegistroConfirmado,
  RegistroSolicitud,
  RegistroVigente,
  SesionEmitida,
  SesionValida,
  SuscripcionAsignada,
  TipoLimite,
} from "./auth/repositorio";
export { AuthRepoError, PlataformaReglaError } from "./auth/errores";
export type { MotivoPlataforma } from "./auth/errores";
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
  resumenTrabajos,
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
  ResumenTrabajoDb,
  TrabajoFila,
  TrabajoVistaDb,
} from "./trabajos/registro";
export { leerConfig } from "./trabajos/config";
export type { ConfigCola } from "./trabajos/config";
export { estudiosConTrabajos, estudiosIds, purgarAuth } from "./trabajos/sistema";
export type { ConteosPurga, RetencionesAuth } from "./trabajos/sistema";
export { TrabajosRepoError } from "./trabajos/errores";
export {
  estadoCredencial,
  leerEstadoCredenciales,
  marcarCredencialInvalida,
  marcarCredencialVerificada,
  versionCredencial,
} from "./credenciales/estado";
export type {
  EstadoCredencialLeido,
  EstadoDeCredencial,
  MotivoEstadoCredencial,
} from "./credenciales/estado";
export { configSistema, jobRegistro } from "./schema/trabajos";
// Spec 006: planes y cupo (todos con la `tx` de withTenant como primer argumento).
export { bloquearCupo, contarRucs, contarUsuarios, leerLimites } from "./planes/cupo";
export type { ConteoUsuarios, LimitesPlan } from "./planes/cupo";
export { usoDelEstudio } from "./planes/uso";
export type { UsoDelEstudio } from "./planes/uso";
export { PlanesRepoError } from "./planes/errores";
export { adminPlataforma, plan, suscripcion } from "./schema/planes";
// Spec 007a: repositorios de clientes (todos con la `tx` de withTenant como primer argumento).
export {
  archivarCliente,
  completarDatosRuc,
  crearCliente,
  editarCliente,
  leerClienteDto,
  listarClientesFiltrado,
  reactivarCliente,
  rucsExistentes,
} from "./clientes/repositorio";
export type { DatosCliente, FiltrosListado } from "./clientes/repositorio";
export { ClienteArchivadoError, RucDuplicadoError } from "./clientes/errores";
// Spec 013: propuestas (encabezado inmutable de cada descarga o importación, común a ventas y compras) y ventas (todas
// con la `tx` de withTenant como primer argumento).
export {
  bloquearPeriodoLibro,
  crearPropuesta,
  insertarDiferencias,
  listarDiferencias,
  listarPropuestas,
} from "./propuestas/repositorio";
export type {
  DiferenciaFila,
  FuentePropuesta,
  LibroPropuesta,
  NuevaDiferencia,
  NuevaPropuesta,
  PropuestaFila,
} from "./propuestas/repositorio";
export { PropuestasRepoError } from "./propuestas/errores";
export { aplicarComplemento, hashContenido } from "./propuestas/complemento";
export type {
  EntradaComplemento,
  ExistenteComplementable,
  FilaComplementable,
  FilaParaHash,
  PlanComplementable,
  ResultadoComplemento,
} from "./propuestas/complemento";
export {
  existenteComplementable,
  prepararFilaVenta,
  TIPO_DOC_AUSENTE,
  tipoCambioConEscala,
} from "./ventas/preparacion";
export type { FilaVentaLegible } from "./ventas/preparacion";
export { leerExistentes, leerFilasVentas, listarVentas, TOPE_TODAS } from "./ventas/lectura";
export { crearVentaManual, insertarVentas, quitarVentaManual } from "./ventas/escritura";
export { justificar, listarJustificados, revertirJustificacion } from "./ventas/justificados";
export { VentasRepoError } from "./ventas/errores";
export type {
  ContextoInsercionVentas,
  DatosJustificar,
  ExistenteVenta,
  FiltrosVentas,
  Justificado,
  MonedaVenta,
  OrigenVenta,
  PaginaVentas,
  VentaFila,
  VentaNueva,
} from "./ventas/tipos";
export { propuesta, propuestaDiferencia } from "./schema/propuestas";
export { venta, ventaSaltoJustificado } from "./schema/ventas";

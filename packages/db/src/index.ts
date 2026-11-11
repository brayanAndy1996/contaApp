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
  encolarLoteXml,
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
  LoteXml,
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
  serieEnMayusculas,
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
  DatosExcluirVenta,
  EstadoPeriodoVenta,
  EstadoPeriodoVentas,
  ExcluidaVenta,
  ExclusionLeida,
  ExclusionVenta,
  Justificado,
  MonedaVenta,
  OrigenVenta,
  PaginaVentas,
  VentaFila,
  VentaNueva,
} from "./ventas/tipos";
export { propuesta, propuestaDiferencia } from "./schema/propuestas";
export { venta, ventaExclusion, ventaPeriodo, ventaSaltoJustificado } from "./schema/ventas";
// Spec 012b: estado del periodo de ventas, exclusión de ventas del SIRE con error y las listas del previo y del worker.
export { fijarEstadoPeriodoVentas, leerEstadoPeriodoVentas } from "./ventas/periodo";
export { exclusionVigente, excluirVenta, restaurarVenta } from "./ventas/exclusion";
export { leerExcluidasVentas, leerFilasReemplazoVentas } from "./ventas/filas-reemplazo";
// Spec 014: repositorios de compras (versiones inmutables con compare-and-set, operaciones con deshacer y rehacer, estado del
// periodo y lecturas del persistidor y de 012b; `evaluar`, `transformar` y `aFila` se inyectan porque este paquete no depende de
// `domain`) y las tablas de drizzle (versiones, operaciones, hallazgos y estado del periodo).
export { ComprasReglaError, ComprasRepoError } from "./compras/errores";
export { agregarCompra, crearVersion, descartar, insertarCompras } from "./compras/versiones";
export type { EntradaCrearVersion } from "./compras/versiones";
export {
  aplicarAccion,
  aplicarMasiva,
  deshacer,
  leerCompraIdsDeOperacion,
  rehacer,
} from "./compras/operaciones";
export { fijarEstadoPeriodo, leerEstadoPeriodo } from "./compras/periodo";
export { leerExistentesCompras, leerProveedoresConocidos } from "./compras/existentes";
export { leerFilasReemplazo } from "./compras/filas-reemplazo";
export {
  leerDetalleCompra,
  leerHallazgosVigentes,
  leerLoteParaResumen,
  leerOrigenesCompras,
  listarCompras,
} from "./compras/lectura";
export type {
  CompraListada,
  CompraParaResumen,
  CursorListado as CursorListadoCompras,
  DetalleLeido as DetalleCompraLeido,
  FiltrosListado as FiltrosListadoCompras,
  HallazgoGuardadoFila as HallazgoGuardadoCompra,
  PaginaListado as PaginaListadoCompras,
  VersionHistorial as VersionHistorialCompra,
  VistaListado as VistaListadoCompras,
} from "./compras/lectura";
export { COLUMNAS_MONTO as COLUMNAS_MONTO_COMPRA } from "./compras/tipos";
export type {
  ColumnaMontoCompra,
  CompraLeida,
  CompraNueva,
  DatosVersion as DatosVersionCompra,
  EstadoPeriodo as EstadoPeriodoCompra,
  EstadoPeriodoCompras,
  Evaluar as EvaluarCompra,
  ExistenteCompra,
  HallazgoNuevo as HallazgoCompra,
  IdentidadCompra,
  MontosCompra,
  ProveedorConocido,
  ResultadoAccion as ResultadoAccionCompra,
  ResultadoMasiva as ResultadoMasivaCompra,
  ResultadoPila as ResultadoPilaCompra,
  ResultadoTransformar as ResultadoTransformarCompra,
  Transformar as TransformarCompra,
  VersionFila as VersionCompra,
} from "./compras/tipos";
export {
  compra,
  compraHallazgo,
  compraOperacion,
  compraPeriodo,
  compraVersion,
} from "./schema/compras";
export type {
  CompraConXml,
  OrigenDocumentoXml,
  XmlParaEvaluar,
} from "./compras/tipos";
// Spec 016: XML de los comprobantes (guardar con P-6 y leer el vigente), estado de obtención, re-evaluación numerada y lecturas
// de la lupa. `packages/db` no parsea XML ni toca el storage: recibe el `detalle` del dominio y lo devuelve opaco.
export {
  guardarDocumentoXml,
  leerXmlVigente,
  normalizarIdentidadXml,
} from "./xml/documentos";
export type {
  EntradaDocumentoXml,
  IdentidadXml,
  ResultadoGuardarXml,
  XmlVigente,
} from "./xml/documentos";
export {
  ESTADOS_OBTENCION,
  fijarObtencion,
  leerObtencion,
  listarPorObtener,
} from "./xml/obtencion";
export type {
  EstadoObtencionXml,
  FilaPorObtener,
  ObtencionXml,
} from "./xml/obtencion";
export { reevaluarCompra, reevaluarComprobante } from "./xml/reevaluar";
export type { BloqueoReevaluar, FuncionesReevaluar, ResultadoReevaluar } from "./xml/reevaluar";
export { leerDetalleXml } from "./xml/detalle";
export type { DetalleXmlLeido } from "./xml/detalle";
export { leerHistorialProveedor, TOPE_HISTORIAL } from "./xml/historial";
export type { CompraHistorialProveedor } from "./xml/historial";
export { compraEvaluacion } from "./schema/compras";
export { documentoXml, documentoXmlObtencion } from "./schema/xml";
// Spec 012b: versiones generadas del archivo de reemplazo (inmutables; solo el worker inserta) y su tabla.
export { ArchivosRepoError } from "./archivos/errores";
export { insertarVersion, ultimaVersion } from "./archivos/versiones";
export type { LibroArchivo, NuevaVersionArchivo, VersionArchivo } from "./archivos/versiones";
export { leerVersion, listarVersiones } from "./archivos/lectura";
export { archivoGenerado } from "./schema/archivos";

// Spec 017 (T7): tablas de auditoría y notificaciones (RLS, grants, triggers y funciones en 0041–0043). Los repositorios son de T8.
export { auditoria } from "./schema/auditoria";
export { notificacion, planAviso } from "./schema/notificaciones";
// Spec 017: auditoría, notificaciones, autores y origen de alta (todos con la `tx` de withTenant como primer argumento).
export {
  leerCambiosDeOperacion,
  listarAuditoria,
  MAX_PAGINA_AUDITORIA,
} from "./auditoria";
export type {
  ActorTipoAuditoria,
  CambioDeCompra,
  FilaAuditoria,
  OpcionesAuditoria,
  VersionCompraAuditada,
} from "./auditoria";
export {
  contarNoLeidas,
  destinatariosNuevos,
  listarNotificaciones,
  marcarLeida,
  marcarLeidasHasta,
  MAX_PAGINA_NOTIFICACIONES,
  purgarNotificaciones,
  TOPE_NO_LEIDAS,
} from "./notificaciones";
export type { FilaNotificacion, OpcionesNotificaciones, TipoNotificacion } from "./notificaciones";
export { resolverAutores } from "./acceso/autores";
export type { AutorResuelto } from "./acceso/autores";
export { marcarOrigenImportacion } from "./clientes/origen";

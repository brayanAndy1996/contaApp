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
export * as schema from "./schema";
export { auditoriaDescifrado, credencial } from "./schema/credenciales";
export { SEED } from "./seed/datos";

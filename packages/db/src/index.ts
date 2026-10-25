export { createDb } from "./client";
export type { ContappDb, ContextoTenant, OpcionesDb, RolApp, Tx } from "./client";
export {
  ConfiguracionDbError,
  ContextoInvalidoError,
  WithTenantAnidadoError,
} from "./errores";
export * as schema from "./schema";
export { SEED } from "./seed/datos";

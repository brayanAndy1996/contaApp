// createDb: pool de conexiones como contapp_app (DATABASE_URL) y acceso a datos solo mediante
// withTenant / withUsuario / withAuth. Nunca registra ni expone la URL de conexión.
import { Pool } from "pg";
import { crearAuthRepo, type AuthRepo } from "./auth/repositorio";
import { ConfiguracionDbError } from "./errores";
import {
  ajusteAuth,
  ajusteTenant,
  ajusteUsuario,
  ejecutarEnContexto,
  esRolApp,
  type ContextoTenant,
  type RolApp,
  type Tx,
} from "./with-tenant";

export type { ContextoTenant, RolApp, Tx } from "./with-tenant";

export interface OpcionesDb {
  rolApp: RolApp;
  /** Por defecto `process.env.DATABASE_URL`. */
  url?: string;
  poolMax?: number;
}

export interface ContappDb {
  withTenant<T>(ctx: ContextoTenant, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** P7: solo fija app.user_id (app.tenant_id sin fijar). */
  withUsuario<T>(ctx: { userId: string }, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /**
   * Spec 004: una transacción como contapp_backend con contexto vacío para llamar a las funciones
   * `auth.*`. Solo con rolApp = contapp_backend; no se anida con withTenant/withUsuario/withAuth.
   */
  withAuth<T>(fn: (a: AuthRepo) => Promise<T>): Promise<T>;
  /**
   * Spec 008 (D18): una transacción como contapp_worker sin estudio (app.tenant_id vacío) para `sistema.*`,
   * `auth.purgar` y config_sistema; la RLS deja vacías las tablas de negocio. Solo con rolApp = contapp_worker
   * (con otro rol rechaza con ConfiguracionDbError sin abrir conexión); no se anida (WithTenantAnidadoError).
   */
  withSistema<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Solo para pruebas (CA-6): fuera de withTenant no tiene permisos sobre tablas. */
  pool: Pool;
  close(): Promise<void>;
}

export function createDb(o: OpcionesDb): ContappDb {
  const rolApp: unknown = o?.rolApp;
  if (!esRolApp(rolApp)) throw new ConfiguracionDbError("rol");
  const url = o.url ?? process.env.DATABASE_URL;
  if (typeof url !== "string" || url.length === 0) {
    throw new ConfiguracionDbError("url");
  }

  const pool = new Pool({
    connectionString: url,
    ...(o.poolMax !== undefined ? { max: o.poolMax } : {}),
  });
  // Un error en una conexión inactiva no debe tumbar el proceso; pg la descarta y abre otra.
  // No se registra nada: el error puede contener datos de conexión.
  pool.on("error", () => undefined);

  let cerrada = false;
  return {
    pool,
    withTenant: (ctx, fn) =>
      ejecutarEnContexto(pool, rolApp, () => ajusteTenant(ctx), fn),
    withUsuario: (ctx, fn) =>
      ejecutarEnContexto(pool, rolApp, () => ajusteUsuario(ctx), fn),
    withAuth: async (fn) => {
      // Solo el backend ejecuta auth.*: con otro rol se rechaza sin abrir conexión.
      if (rolApp !== "contapp_backend") throw new ConfiguracionDbError("rol");
      return ejecutarEnContexto(pool, rolApp, ajusteAuth, (tx) => fn(crearAuthRepo(tx)));
    },
    withSistema: async (fn) => {
      // Solo el worker enumera estudios y purga: el backend nunca obtiene este contexto.
      if (rolApp !== "contapp_worker") throw new ConfiguracionDbError("rol");
      // Mismo contexto vacío que withAuth (app.tenant_id y app.user_id = '').
      return ejecutarEnContexto(pool, rolApp, ajusteAuth, fn);
    },
    close: async () => {
      if (cerrada) return;
      cerrada = true;
      await pool.end();
    },
  };
}

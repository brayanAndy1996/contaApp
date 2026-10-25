// createDb: pool de conexiones como contapp_app (DATABASE_URL) y acceso a datos solo mediante
// withTenant / withUsuario. Nunca registra ni expone la URL de conexión.
import { Pool } from "pg";
import { ConfiguracionDbError } from "./errores";
import {
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
    close: async () => {
      if (cerrada) return;
      cerrada = true;
      await pool.end();
    },
  };
}

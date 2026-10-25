// Stub de T3 (tester): T6 lo reemplaza con la implementación final.
import type { Pool } from "pg";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

export type RolApp = "contapp_backend" | "contapp_worker";
export interface ContextoTenant {
  tenantId: string;
  userId?: string;
}
export type Tx = NodePgDatabase;
export interface ContappDb {
  withTenant<T>(ctx: ContextoTenant, fn: (tx: Tx) => Promise<T>): Promise<T>;
  withUsuario<T>(
    ctx: { userId: string },
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T>;
  pool: Pool;
  close(): Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function createDb(_o: {
  rolApp: RolApp;
  url?: string;
  poolMax?: number;
}): ContappDb {
  throw new Error("no implementado");
}

import { sql } from "drizzle-orm";
import { timestamp, uuid } from "drizzle-orm/pg-core";

// Convenciones de 03 §8: PK uuid v7 (función SQL de 0000_roles) y marcas de tiempo.
export const id = () => uuid("id").primaryKey().default(sql`uuid_v7()`);

export const marcasDeTiempo = () => ({
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// tenant_id toma el contexto de withTenant por defecto; nullif evita el error de cast con GUC vacío.
export const tenantIdPorDefecto = sql`nullif(current_setting('app.tenant_id', true), '')::uuid`;

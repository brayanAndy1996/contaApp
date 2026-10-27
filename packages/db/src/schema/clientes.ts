import { sql } from "drizzle-orm";
import { char, check, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { id, marcasDeTiempo, tenantIdPorDefecto } from "./comun";
import { tenant } from "./plataforma";

// Tabla de negocio de ejemplo (D1); 007 la amplía con su migración. RLS en 0002_rls_y_grants.
export const cliente = pgTable(
  "cliente",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .default(tenantIdPorDefecto)
      .references(() => tenant.id),
    ruc: char("ruc", { length: 11 }).notNull(),
    razonSocial: text("razon_social").notNull(),
    ...marcasDeTiempo(),
  },
  (t) => [
    unique("cliente_tenant_ruc_unique").on(t.tenantId, t.ruc),
    unique("cliente_tenant_id_unique").on(t.tenantId, t.id),
    check("cliente_ruc_11_digitos", sql`${t.ruc} ~ '^[0-9]{11}$'`),
  ],
);

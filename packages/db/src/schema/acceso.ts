import { pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { id, marcasDeTiempo, tenantIdPorDefecto } from "./comun";
import { tenant, usuario } from "./plataforma";

// Tabla de negocio con RLS (políticas en 0002_rls_y_grants).
export const membresia = pgTable(
  "membresia",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .default(tenantIdPorDefecto)
      .references(() => tenant.id),
    usuarioId: uuid("usuario_id")
      .notNull()
      .references(() => usuario.id),
    rol: text("rol").notNull(),
    ...marcasDeTiempo(),
  },
  (t) => [unique("membresia_tenant_usuario_unique").on(t.tenantId, t.usuarioId)],
);

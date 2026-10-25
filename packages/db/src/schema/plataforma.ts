import { pgTable, text } from "drizzle-orm/pg-core";
import { id, marcasDeTiempo } from "./comun";

// Tablas de plataforma: sin tenant_id ni RLS (03 §8).
export const tenant = pgTable("tenant", {
  id: id(),
  nombre: text("nombre").notNull(),
  ...marcasDeTiempo(),
});

export const usuario = pgTable("usuario", {
  id: id(),
  email: text("email").notNull().unique("usuario_email_unique"),
  nombre: text("nombre").notNull(),
  ...marcasDeTiempo(),
});

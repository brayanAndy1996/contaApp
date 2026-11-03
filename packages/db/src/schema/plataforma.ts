import { sql } from "drizzle-orm";
import { check, pgTable, text } from "drizzle-orm/pg-core";
import { id, marcasDeTiempo } from "./comun";

// Tablas de plataforma: sin tenant_id (03 §8). RLS de solo lectura para backend/worker (H6, 0003).
// Spec 006 (D2): ruc_estudio es informativo (11 dígitos o NULL, sin unicidad); lo fija el registro.
export const tenant = pgTable(
  "tenant",
  {
    id: id(),
    nombre: text("nombre").notNull(),
    rucEstudio: text("ruc_estudio"),
    ...marcasDeTiempo(),
  },
  (t) => [
    check("tenant_ruc_estudio_11_digitos", sql`${t.rucEstudio} ~ '^[0-9]{11}$'`),
  ],
);

export const usuario = pgTable("usuario", {
  id: id(),
  email: text("email").notNull().unique("usuario_email_unique"),
  nombre: text("nombre").notNull(),
  ...marcasDeTiempo(),
});

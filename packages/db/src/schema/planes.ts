import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { id, marcasDeTiempo, tenantIdPorDefecto } from "./comun";
import { tenant, usuario } from "./plataforma";

// Spec 006 (D1, D5, D6, D10). Va aparte del índice del esquema (el inventario de 002 fija sus tablas). RLS de
// `suscripcion`, dueño y grants por columna en 0023_planes_rls; políticas de contapp_auth en 0024_planes_auth.

/** Plan de plataforma (sin tenant_id). Montos NUMERIC(14,2): pg los devuelve como cadena. */
export const plan = pgTable(
  "plan",
  {
    id: id(),
    codigo: text("codigo").notNull().unique("plan_codigo_unique"),
    nombre: text("nombre").notNull(),
    precioMensual: numeric("precio_mensual", { precision: 14, scale: 2 }).notNull(),
    precioAnual: numeric("precio_anual", { precision: 14, scale: 2 }),
    maxRucs: integer("max_rucs").notNull(),
    /** NULL = sin límite de usuarios (Corporativo). */
    maxUsuarios: integer("max_usuarios"),
    precioRucExtra: numeric("precio_ruc_extra", { precision: 14, scale: 2 }).notNull().default("0"),
    maxRucsExtra: integer("max_rucs_extra").notNull().default(0),
    frecuenciaBuzonMin: integer("frecuencia_buzon_min").notNull(),
    features: jsonb("features").notNull().default(sql`'{}'::jsonb`),
    activo: boolean("activo").notNull().default(true),
    ...marcasDeTiempo(),
  },
  (t) => [
    check("plan_precio_mensual_no_negativo", sql`${t.precioMensual} >= 0`),
    check("plan_precio_anual_no_negativo", sql`${t.precioAnual} >= 0`),
    check("plan_max_rucs_positivo", sql`${t.maxRucs} >= 1`),
    check("plan_max_usuarios_positivo", sql`${t.maxUsuarios} >= 1`),
    check("plan_precio_ruc_extra_no_negativo", sql`${t.precioRucExtra} >= 0`),
    // D6: el tope de RUCs adicionales es como máximo el 20 % del plan.
    check(
      "plan_max_rucs_extra_tope",
      sql`${t.maxRucsExtra} >= 0 AND ${t.maxRucsExtra} * 5 <= ${t.maxRucs}`,
    ),
    check("plan_frecuencia_buzon_positiva", sql`${t.frecuenciaBuzonMin} >= 1`),
    check("plan_features_objeto", sql`jsonb_typeof(${t.features}) = 'object'`),
  ],
);

/** Suscripción del estudio (una por estudio). El backend solo la lee (RLS, SELECT). */
export const suscripcion = pgTable(
  "suscripcion",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .default(tenantIdPorDefecto)
      .references(() => tenant.id),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plan.id),
    estado: text("estado").notNull(),
    pruebaVenceEn: timestamp("prueba_vence_en", { withTimezone: true }),
    rucsExtraContratados: integer("rucs_extra_contratados").notNull().default(0),
    ...marcasDeTiempo(),
  },
  (t) => [
    unique("suscripcion_tenant_unique").on(t.tenantId),
    check("suscripcion_estado_valido", sql`${t.estado} IN ('prueba', 'activa')`),
    check(
      "suscripcion_prueba_vence",
      sql`${t.estado} <> 'prueba' OR ${t.pruebaVenceEn} IS NOT NULL`,
    ),
    check("suscripcion_rucs_extra_no_negativo", sql`${t.rucsExtraContratados} >= 0`),
  ],
);

/** Super-admin de plataforma (D5): alta solo por seed o CLI; las funciones `auth.*` la revalidan. */
export const adminPlataforma = pgTable("admin_plataforma", {
  usuarioId: uuid("usuario_id")
    .primaryKey()
    .references(() => usuario.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

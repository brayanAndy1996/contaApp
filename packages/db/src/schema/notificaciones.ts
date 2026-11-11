import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { id, tenantIdPorDefecto } from "./comun";
import { tenant } from "./plataforma";

// Spec 017 (D-8, D-9): una notificación en la app para un usuario del estudio. Solo la BD inserta (triggers y funciones
// SECURITY DEFINER de 0043, en la misma transacción del hecho); el backend lee y solo cambia `leida_en` (NULL -> valor).
// `creada_en` en milisegundos: el cursor viaja como Date. Sin FK a job_registro (la purga de trabajos no se bloquea).
export const notificacion = pgTable(
  "notificacion",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .default(tenantIdPorDefecto)
      .references(() => tenant.id),
    usuarioId: uuid("usuario_id").notNull(),
    tipo: text("tipo").notNull(),
    clienteId: uuid("cliente_id"),
    trabajoId: uuid("trabajo_id"),
    params: jsonb("params").notNull().default(sql`'{}'::jsonb`),
    claveDedupe: text("clave_dedupe").notNull(),
    creadaEn: timestamp("creada_en", { withTimezone: true })
      .notNull()
      .default(sql`date_trunc('milliseconds', now())`),
    leidaEn: timestamp("leida_en", { withTimezone: true }),
  },
  (t) => [
    unique("notificacion_dedupe_unique").on(t.tenantId, t.usuarioId, t.claveDedupe),
    index("notificacion_usuario_idx").on(t.tenantId, t.usuarioId, t.creadaEn.desc(), t.id.desc()),
    index("notificacion_purga_idx").on(t.tenantId, t.creadaEn),
    check(
      "notificacion_tipo_valido",
      sql`${t.tipo} IN ('credencial_invalida', 'trabajo_terminado', 'plan_limite', 'buzon_critico')`,
    ),
    check(
      "notificacion_params_objeto",
      sql`jsonb_typeof(${t.params}) = 'object' AND pg_column_size(${t.params}) <= 1024`,
    ),
    check("notificacion_clave_largo", sql`char_length(${t.claveDedupe}) BETWEEN 1 AND 200`),
  ],
);

// Spec 017 (P-5, CA-10): estado del aviso de límite del plan por estudio, recurso y umbral. Lo escribe solo
// `plan_aviso_recalcular` (0043); sin grants a los roles de la app. `ciclo` cuenta los cruces (clave de la notificación).
export const planAviso = pgTable(
  "plan_aviso",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    recurso: text("recurso").notNull(),
    umbral: smallint("umbral").notNull(),
    alcanzado: boolean("alcanzado").notNull().default(false),
    ciclo: integer("ciclo").notNull().default(0),
  },
  (t) => [
    primaryKey({ name: "plan_aviso_pk", columns: [t.tenantId, t.recurso, t.umbral] }),
    check("plan_aviso_recurso_valido", sql`${t.recurso} IN ('rucs', 'usuarios')`),
    check("plan_aviso_umbral_valido", sql`${t.umbral} IN (90, 100)`),
    check("plan_aviso_ciclo_no_negativo", sql`${t.ciclo} >= 0`),
  ],
);

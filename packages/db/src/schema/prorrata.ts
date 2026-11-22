import { sql } from "drizzle-orm";
import {
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { cliente } from "./clientes";
import { id, tenantIdPorDefecto } from "./comun";
import { tenant, usuario } from "./plataforma";

// Spec 026 (D-3, D-4, D-6; R-5, R-8). Prorrata: obtenciones del PDT 621, sus presentaciones, meses ingresados a mano y la prorrata
// usada ingresada. Las cuatro son SOLO DE INSERCIÓN (trigger BEFORE UPDATE OR DELETE: 42501 salvo superusuario) y nadie de la app
// escribe directo: escriben las funciones acotadas de 0066. RLS ENABLE + FORCE, tenant_isolation y grants en 0065 (backend SELECT;
// worker nada). Va aparte del índice del esquema, como 014–025. Ninguna columna termina en `_at` (013: `_en`).

const tenantId = () =>
  uuid("tenant_id")
    .notNull()
    .default(tenantIdPorDefecto)
    .references(() => tenant.id);

/** Tipos de presentación del PDT 621. */
export const TIPOS_DECLARACION_BD = ["original", "rectificatoria"] as const;
/** Acciones de una versión del mes manual: `eliminado` deja los tres montos en NULL y cuenta como versión. */
export const ACCIONES_MES_MANUAL_BD = ["guardado", "eliminado"] as const;

const lista = (valores: readonly string[]) => sql.raw(valores.map((v) => `'${v}'`).join(", "));
const PERIODO = sql.raw(`'^[0-9]{4}(0[1-9]|1[0-2])$'`);
/**
 * Controles C0 y C1 (salto de línea incluido), separadores de línea y párrafo Unicode (U+2028, U+2029; 0068, H-026-2-5) y marcas
 * bidireccionales: prohibidos en el motivo (como 025, D-11).
 */
const CONTROLES_O_BIDI = sql.raw(
  `'[\\u0001-\\u001F\\u007F-\\u009F\\u061C\\u200E\\u200F\\u2028\\u2029\\u202A-\\u202E\\u2066-\\u2069]'`,
);
const monto = (nombre: string) => numeric(nombre, { precision: 14, scale: 2 });
const porcentaje = (nombre: string) => numeric(nombre, { precision: 5, scale: 2 });

// 0065. Una fila por llamada del worker (también la repetida, con nuevas = 0): qué periodos leyó y cuáles no tenían declaración.
export const prorrataObtencion = pgTable(
  "prorrata_obtencion",
  {
    id: id(),
    tenantId: tenantId(),
    clienteId: uuid("cliente_id").notNull(),
    periodoHasta: char("periodo_hasta", { length: 6 }).notNull(),
    trabajoId: uuid("trabajo_id"),
    periodosLeidos: char("periodos_leidos", { length: 6 }).array().notNull(),
    periodosSinDeclaracion: char("periodos_sin_declaracion", { length: 6 })
      .array()
      .notNull()
      .default(sql`'{}'::char(6)[]`),
    nuevas: integer("nuevas").notNull().default(0),
    obtenidaEn: timestamp("obtenida_en", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  },
  (t) => [
    unique("prorrata_obtencion_cliente_id_unique").on(t.tenantId, t.clienteId, t.id),
    index("prorrata_obtencion_cliente_idx").on(t.tenantId, t.clienteId, t.periodoHasta, t.obtenidaEn),
    foreignKey({
      name: "prorrata_obtencion_cliente_fk",
      columns: [t.tenantId, t.clienteId],
      foreignColumns: [cliente.tenantId, cliente.id],
    }),
    check("prorrata_obtencion_periodo_hasta_formato", sql`${t.periodoHasta} ~ ${PERIODO}`),
    check(
      "prorrata_obtencion_periodos_cantidad",
      sql`cardinality(${t.periodosLeidos}) <= 12 AND cardinality(${t.periodosSinDeclaracion}) <= 12`,
    ),
    check("prorrata_obtencion_nuevas_no_negativa", sql`${t.nuevas} >= 0`),
  ],
);

// 0065. Una fila por presentación (original y rectificatorias); la vigente (mayor número de orden) se decide al leer (R-5).
export const declaracionMensual = pgTable(
  "declaracion_mensual",
  {
    id: id(),
    tenantId: tenantId(),
    clienteId: uuid("cliente_id").notNull(),
    periodo: char("periodo", { length: 6 }).notNull(),
    numeroOrden: numeric("numero_orden", { precision: 15, scale: 0 }).notNull(),
    fechaPresentacion: date("fecha_presentacion", { mode: "string" }).notNull(),
    tipo: text("tipo").notNull(),
    ventasGravadasBase: monto("ventas_gravadas_base").notNull(),
    ventasGravadasIgv: monto("ventas_gravadas_igv").notNull(),
    exportaciones: monto("exportaciones").notNull(),
    noGravadas: monto("no_gravadas").notNull(),
    igvAdqDg: monto("igv_adq_dg").notNull(),
    igvAdqDgng: monto("igv_adq_dgng").notNull(),
    prorrataUsada: porcentaje("prorrata_usada"),
    obtencionId: uuid("obtencion_id").notNull(),
  },
  (t) => [
    unique("declaracion_mensual_orden_unique").on(t.tenantId, t.clienteId, t.periodo, t.numeroOrden),
    index("declaracion_mensual_obtencion_idx").on(t.tenantId, t.clienteId, t.obtencionId),
    foreignKey({
      name: "declaracion_mensual_cliente_fk",
      columns: [t.tenantId, t.clienteId],
      foreignColumns: [cliente.tenantId, cliente.id],
    }),
    foreignKey({
      name: "declaracion_mensual_obtencion_fk",
      columns: [t.tenantId, t.clienteId, t.obtencionId],
      foreignColumns: [prorrataObtencion.tenantId, prorrataObtencion.clienteId, prorrataObtencion.id],
    }),
    check("declaracion_mensual_periodo_formato", sql`${t.periodo} ~ ${PERIODO}`),
    check("declaracion_mensual_numero_orden_positivo", sql`${t.numeroOrden} > 0`),
    check("declaracion_mensual_tipo_valido", sql`${t.tipo} IN (${lista(TIPOS_DECLARACION_BD)})`),
    check(
      "declaracion_mensual_prorrata_usada_rango",
      sql`${t.prorrataUsada} IS NULL OR ${t.prorrataUsada} BETWEEN 0 AND 100`,
    ),
  ],
);

// 0065. Mes ingresado a mano, versionado: cada guardado o eliminación es una fila nueva (historial completo; CAS por la única).
export const prorrataMesManual = pgTable(
  "prorrata_mes_manual",
  {
    id: id(),
    tenantId: tenantId(),
    clienteId: uuid("cliente_id").notNull(),
    periodo: char("periodo", { length: 6 }).notNull(),
    version: integer("version").notNull(),
    accion: text("accion").notNull(),
    gravadas: monto("gravadas"),
    exportaciones: monto("exportaciones"),
    noGravadas: monto("no_gravadas"),
    motivo: text("motivo").notNull(),
    autor: uuid("autor")
      .notNull()
      .references(() => usuario.id),
    creadoEn: timestamp("creado_en", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  },
  (t) => [
    unique("prorrata_mes_manual_version_unique").on(t.tenantId, t.clienteId, t.periodo, t.version),
    foreignKey({
      name: "prorrata_mes_manual_cliente_fk",
      columns: [t.tenantId, t.clienteId],
      foreignColumns: [cliente.tenantId, cliente.id],
    }),
    check("prorrata_mes_manual_periodo_formato", sql`${t.periodo} ~ ${PERIODO}`),
    check("prorrata_mes_manual_version_positiva", sql`${t.version} >= 1`),
    check("prorrata_mes_manual_accion_valida", sql`${t.accion} IN (${lista(ACCIONES_MES_MANUAL_BD)})`),
    check(
      "prorrata_mes_manual_montos_coherentes",
      sql`CASE WHEN ${t.accion} = 'guardado' THEN ${t.gravadas} IS NOT NULL AND ${t.exportaciones} IS NOT NULL AND ${t.noGravadas} IS NOT NULL ELSE ${t.gravadas} IS NULL AND ${t.exportaciones} IS NULL AND ${t.noGravadas} IS NULL END`,
    ),
    check(
      "prorrata_mes_manual_motivo_valido",
      sql`char_length(${t.motivo}) BETWEEN 1 AND 500 AND ${t.motivo} !~ ${CONTROLES_O_BIDI}`,
    ),
  ],
);

// 0065. Prorrata usada ingresada por el contador cuando el PDT vigente no la trae (R-8, U-9), versionada; NULL deja el mes sin valor.
export const prorrataUsadaManual = pgTable(
  "prorrata_usada_manual",
  {
    id: id(),
    tenantId: tenantId(),
    clienteId: uuid("cliente_id").notNull(),
    periodo: char("periodo", { length: 6 }).notNull(),
    version: integer("version").notNull(),
    porcentaje: porcentaje("porcentaje"),
    autor: uuid("autor")
      .notNull()
      .references(() => usuario.id),
    creadoEn: timestamp("creado_en", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  },
  (t) => [
    unique("prorrata_usada_manual_version_unique").on(t.tenantId, t.clienteId, t.periodo, t.version),
    foreignKey({
      name: "prorrata_usada_manual_cliente_fk",
      columns: [t.tenantId, t.clienteId],
      foreignColumns: [cliente.tenantId, cliente.id],
    }),
    check("prorrata_usada_manual_periodo_formato", sql`${t.periodo} ~ ${PERIODO}`),
    check("prorrata_usada_manual_version_positiva", sql`${t.version} >= 1`),
    check(
      "prorrata_usada_manual_porcentaje_rango",
      sql`${t.porcentaje} IS NULL OR ${t.porcentaje} BETWEEN 0 AND 100`,
    ),
  ],
);

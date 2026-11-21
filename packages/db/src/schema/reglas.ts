import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { cliente } from "./clientes";
import { compraVersion } from "./compras";
import { id, tenantIdPorDefecto } from "./comun";
import { tenant, usuario } from "./plataforma";

// Spec 021 (D-2, D-3, D-8, P-9, P-10). Reglas aprendidas por cliente y proveedor, interruptores del motor del estudio y aporte al
// catálogo. RLS ENABLE + FORCE, tenant_isolation, grants, funciones acotadas y triggers de auditoría en 0047–0049. Va aparte del
// índice del esquema, como 014–017. Ninguna columna termina en `_at` (013: `_en`).

const tenantId = () =>
  uuid("tenant_id")
    .notNull()
    .default(tenantIdPorDefecto)
    .references(() => tenant.id);

/** Destinos de una regla aprendida: el par de BI e IGV en el que se consolida la compra. */
export const DESTINOS_REGLA_BD = ["DG", "DGNG", "DNG"] as const;
/** Reglas del motor que el estudio puede apagar (RF-089). La prevalidación de 012 no figura (P-8). */
export const CODIGOS_REGLA_MOTOR_BD = ["R-ISC", "R-MIX", "R-RED", "R-NEW", "R-GP", "R-HIS", "R-STD"] as const;
/** Origen de una regla aprendida (025): «Recordar» del contador o activación de una candidata importada del historial. */
export const ORIGENES_REGLA_BD = ["contador", "importacion"] as const;

const lista = (valores: readonly string[]) => sql.raw(valores.map((v) => `'${v}'`).join(", "));

// 0047. Una regla viva por (cliente, proveedor): la única es parcial y la baja es lógica (eliminada_en), así que se puede volver a
// crear. `version` sirve de compare-and-set para editar, recordar y eliminar (D-5).
export const reglaAprendida = pgTable(
  "regla_aprendida",
  {
    id: id(),
    tenantId: tenantId(),
    clienteId: uuid("cliente_id").notNull(),
    docTipo: text("doc_tipo").notNull(),
    docNumero: text("doc_numero").notNull(),
    destino: text("destino").notNull(),
    activa: boolean("activa").notNull().default(true),
    version: integer("version").notNull().default(1),
    periodoAprendido: char("periodo_aprendido", { length: 6 }).notNull(),
    creadaPor: uuid("creada_por").notNull(),
    creadaEn: timestamp("creada_en", { withTimezone: true }).notNull().defaultNow(),
    actualizadaPor: uuid("actualizada_por").notNull(),
    actualizadaEn: timestamp("actualizada_en", { withTimezone: true }).notNull().defaultNow(),
    eliminadaEn: timestamp("eliminada_en", { withTimezone: true }),
    eliminadaPor: uuid("eliminada_por"),
    // 025 (0061): solo reglas_candidatas_activar escribe 'importacion'; el INSERT del backend es por columnas y no la nombra.
    origen: text("origen").notNull().default("contador"),
  },
  (t) => [
    unique("regla_aprendida_tenant_id_unique").on(t.tenantId, t.id),
    uniqueIndex("regla_aprendida_viva_unique")
      .on(t.tenantId, t.clienteId, t.docTipo, t.docNumero)
      .where(sql`${t.eliminadaEn} IS NULL`),
    foreignKey({
      name: "regla_aprendida_cliente_fk",
      columns: [t.tenantId, t.clienteId],
      foreignColumns: [cliente.tenantId, cliente.id],
    }),
    check("regla_aprendida_destino_valido", sql`${t.destino} IN (${lista(DESTINOS_REGLA_BD)})`),
    check("regla_aprendida_version_positiva", sql`${t.version} >= 1`),
    check("regla_aprendida_periodo_formato", sql`${t.periodoAprendido} ~ '^[0-9]{4}(0[1-9]|1[0-2])$'`),
    check(
      "regla_aprendida_documento_largo",
      sql`char_length(${t.docTipo}) BETWEEN 1 AND 2 AND char_length(${t.docNumero}) BETWEEN 1 AND 20`,
    ),
    check("regla_aprendida_baja_coherente", sql`(${t.eliminadaEn} IS NULL) = (${t.eliminadaPor} IS NULL)`),
    check("regla_aprendida_origen_valido", sql`${t.origen} IN (${lista(ORIGENES_REGLA_BD)})`),
  ],
);

// 0047. Interruptor de una regla del motor por estudio: sin fila = encendida.
export const estudioReglaMotor = pgTable(
  "estudio_regla_motor",
  {
    tenantId: tenantId(),
    codigo: text("codigo").notNull(),
    activa: boolean("activa").notNull().default(true),
    actualizadaPor: uuid("actualizada_por").notNull(),
    actualizadaEn: timestamp("actualizada_en", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "estudio_regla_motor_pk", columns: [t.tenantId, t.codigo] }),
    check("estudio_regla_motor_codigo_valido", sql`${t.codigo} IN (${lista(CODIGOS_REGLA_MOTOR_BD)})`),
  ],
);

// 0047. Aporte de las confirmaciones al catálogo (P-10): sin fila = encendido.
export const estudioReglasConfig = pgTable("estudio_reglas_config", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .default(tenantIdPorDefecto)
    .references(() => tenant.id),
  aportarCatalogo: boolean("aportar_catalogo").notNull().default(true),
});

// 0048. Una fila por versión `historial` creada por `aplicar_regla_historial` (D-8): solo inserción, sin grants de escritura a la
// app. Cuenta como «aplicada» (P-4).
export const reglaAplicacion = pgTable(
  "regla_aplicacion",
  {
    id: id(),
    tenantId: tenantId(),
    reglaId: uuid("regla_id").notNull(),
    compraId: uuid("compra_id").notNull(),
    versionN: integer("version_n").notNull(),
    periodo: char("periodo", { length: 6 }).notNull(),
    creadaEn: timestamp("creada_en", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("regla_aplicacion_tenant_id_unique").on(t.tenantId, t.id),
    unique("regla_aplicacion_version_unique").on(t.tenantId, t.compraId, t.versionN),
    foreignKey({
      name: "regla_aplicacion_regla_fk",
      columns: [t.tenantId, t.reglaId],
      foreignColumns: [reglaAprendida.tenantId, reglaAprendida.id],
    }),
    foreignKey({
      name: "regla_aplicacion_version_fk",
      columns: [t.tenantId, t.compraId, t.versionN],
      foreignColumns: [compraVersion.tenantId, compraVersion.compraId, compraVersion.n],
    }),
    index("regla_aplicacion_regla_idx").on(t.tenantId, t.reglaId),
    check("regla_aplicacion_version_historial", sql`${t.versionN} >= 2`),
    check("regla_aplicacion_periodo_formato", sql`${t.periodo} ~ '^[0-9]{4}(0[1-9]|1[0-2])$'`),
  ],
);

// 0049. Aceptación de una aplicación (P-4): la registra el trigger de `compra_periodo` al pasar a `revisado` si la compra sigue en el
// destino de la regla. Solo inserción; una por aplicación (reabrir y revisar no duplica).
export const reglaAceptacion = pgTable(
  "regla_aceptacion",
  {
    tenantId: tenantId(),
    reglaAplicacionId: uuid("regla_aplicacion_id").primaryKey(),
    reglaId: uuid("regla_id").notNull(),
    periodo: char("periodo", { length: 6 }).notNull(),
    creadaEn: timestamp("creada_en", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "regla_aceptacion_aplicacion_fk",
      columns: [t.tenantId, t.reglaAplicacionId],
      foreignColumns: [reglaAplicacion.tenantId, reglaAplicacion.id],
    }),
    foreignKey({
      name: "regla_aceptacion_regla_fk",
      columns: [t.tenantId, t.reglaId],
      foreignColumns: [reglaAprendida.tenantId, reglaAprendida.id],
    }),
    index("regla_aceptacion_regla_idx").on(t.tenantId, t.reglaId),
  ],
);

// 0049. Confirmación para el catálogo de plataforma (D-3, P-1, P-10): solo RUC 20 y con el aporte del estudio encendido. Sin
// usuario, montos ni razón social. Ningún rol de la app la lee; solo el backend inserta (`recordar`) y el trigger de revisado
// (`aceptada`).
export const reglaConfirmacion = pgTable(
  "regla_confirmacion",
  {
    id: id(),
    tenantId: tenantId(),
    reglaId: uuid("regla_id").notNull(),
    clienteId: uuid("cliente_id").notNull(),
    rucProveedor: text("ruc_proveedor").notNull(),
    destino: text("destino").notNull(),
    origen: text("origen").notNull(),
    creadaEn: timestamp("creada_en", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "regla_confirmacion_regla_fk",
      columns: [t.tenantId, t.reglaId],
      foreignColumns: [reglaAprendida.tenantId, reglaAprendida.id],
    }),
    foreignKey({
      name: "regla_confirmacion_cliente_fk",
      columns: [t.tenantId, t.clienteId],
      foreignColumns: [cliente.tenantId, cliente.id],
    }),
    index("regla_confirmacion_regla_idx").on(t.tenantId, t.reglaId),
    check("regla_confirmacion_origen_valido", sql`${t.origen} IN ('recordar', 'aceptada')`),
    check("regla_confirmacion_destino_valido", sql`${t.destino} IN (${lista(DESTINOS_REGLA_BD)})`),
    check("regla_confirmacion_ruc_20", sql`${t.rucProveedor} ~ '^20[0-9]{9}$'`),
  ],
);

// ---- Spec 025 (D-2, D-4 a D-7, D-11; 0061) -----------------------------------------------------------------------------------
// Aprendizaje de arranque: importaciones del registro presentado y candidatas por proveedor. Nadie de la app escribe directo: solo
// las funciones acotadas de 0062 (RLS ENABLE + FORCE, grants y trigger de borrado en 0061). Estados y motivos como CHECK.

export const ESTADOS_IMPORTACION_BD = ["en_curso", "completada", "fallida"] as const;
export const ESTADOS_CANDIDATA_BD = ["pendiente", "activada", "descartada", "reemplazada"] as const;
/** Los motivos de trabajo de 008 (`job_registro_motivo_valido`). */
export const MOTIVOS_IMPORTACION_BD = [
  "sunat_no_responde",
  "credencial_invalida",
  "datos_invalidos",
  "portal_cambio",
  "interrumpido",
  "acceso_retirado",
  "cancelado_usuario",
  "error_interno",
] as const;
/** Controles C0 y C1 (salto de línea incluido) y marcas bidireccionales: prohibidos en la razón social (D-11). */
const CONTROLES_O_BIDI = sql.raw(`'[\\u0001-\\u001F\\u007F-\\u009F\\u061C\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]'`);
const PERIODO = `'^[0-9]{4}(0[1-9]|1[0-2])$'`;

// 0061. Una importación por pedido; una sola `en_curso` por cliente (única parcial). Periodos y cliente viven aquí, no en el payload
// del trabajo. El resumen lo deja `reglas_importacion_completar`; el motivo, `reglas_importacion_fallar` o el autocierre de iniciar.
export const reglaImportacion = pgTable(
  "regla_importacion",
  {
    id: id(),
    tenantId: tenantId(),
    clienteId: uuid("cliente_id").notNull(),
    estado: text("estado").notNull().default("en_curso"),
    periodos: char("periodos", { length: 6 }).array().notNull(),
    periodoHasta: char("periodo_hasta", { length: 6 }).notNull(),
    trabajoId: uuid("trabajo_id"),
    solicitadaPor: uuid("solicitada_por")
      .notNull()
      .references(() => usuario.id),
    solicitadaEn: timestamp("solicitada_en", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
    terminadaEn: timestamp("terminada_en", { withTimezone: true }),
    periodosLeidos: integer("periodos_leidos"),
    periodosSinDatos: char("periodos_sin_datos", { length: 6 }).array(),
    candidatas: integer("candidatas"),
    sinCriterio: integer("sin_criterio"),
    motivo: text("motivo"),
  },
  (t) => [
    unique("regla_importacion_cliente_id_unique").on(t.tenantId, t.clienteId, t.id),
    uniqueIndex("regla_importacion_en_curso_unique")
      .on(t.tenantId, t.clienteId)
      .where(sql`${t.estado} = 'en_curso'`),
    index("regla_importacion_cliente_idx").on(t.tenantId, t.clienteId, t.solicitadaEn),
    foreignKey({
      name: "regla_importacion_cliente_fk",
      columns: [t.tenantId, t.clienteId],
      foreignColumns: [cliente.tenantId, cliente.id],
    }),
    check("regla_importacion_estado_valido", sql`${t.estado} IN (${lista(ESTADOS_IMPORTACION_BD)})`),
    check("regla_importacion_periodos_cantidad", sql`cardinality(${t.periodos}) BETWEEN 1 AND 12`),
    check("regla_importacion_periodo_hasta_formato", sql`${t.periodoHasta} ~ ${sql.raw(PERIODO)}`),
    check(
      "regla_importacion_motivo_valido",
      sql`${t.motivo} IS NULL OR ${t.motivo} IN (${lista(MOTIVOS_IMPORTACION_BD)})`,
    ),
    check(
      "regla_importacion_resumen_no_negativo",
      sql`coalesce(${t.periodosLeidos}, 0) >= 0 AND coalesce(${t.candidatas}, 0) >= 0 AND coalesce(${t.sinCriterio}, 0) >= 0 AND coalesce(cardinality(${t.periodosSinDatos}), 0) <= 12`,
    ),
  ],
);

// 0061. Una candidata por proveedor e importación. Con destino propuesto, el umbral de U-2 (al menos 2 y 5n >= 4t, en enteros).
// `regla_id` y `resuelta_*` solo fuera de `pendiente`; `regla_id` solo en `activada`.
export const reglaCandidata = pgTable(
  "regla_candidata",
  {
    id: id(),
    tenantId: tenantId(),
    clienteId: uuid("cliente_id").notNull(),
    importacionId: uuid("importacion_id").notNull(),
    docTipo: text("doc_tipo").notNull(),
    docNumero: text("doc_numero").notNull(),
    razonSocial: text("razon_social"),
    destinoPropuesto: text("destino_propuesto"),
    nDg: integer("n_dg").notNull().default(0),
    nDgng: integer("n_dgng").notNull().default(0),
    nDng: integer("n_dng").notNull().default(0),
    nMixto: integer("n_mixto").notNull().default(0),
    nTotal: integer("n_total").notNull(),
    periodosConProveedor: integer("periodos_con_proveedor").notNull(),
    estado: text("estado").notNull().default("pendiente"),
    destinoElegido: text("destino_elegido"),
    reglaId: uuid("regla_id"),
    resueltaPor: uuid("resuelta_por").references(() => usuario.id),
    resueltaEn: timestamp("resuelta_en", { withTimezone: true }),
  },
  (t) => [
    unique("regla_candidata_documento_unique").on(t.tenantId, t.importacionId, t.docTipo, t.docNumero),
    index("regla_candidata_cliente_idx").on(t.tenantId, t.clienteId, t.estado, t.docTipo, t.docNumero),
    foreignKey({
      name: "regla_candidata_importacion_fk",
      columns: [t.tenantId, t.clienteId, t.importacionId],
      foreignColumns: [reglaImportacion.tenantId, reglaImportacion.clienteId, reglaImportacion.id],
    }),
    foreignKey({
      name: "regla_candidata_regla_fk",
      columns: [t.tenantId, t.reglaId],
      foreignColumns: [reglaAprendida.tenantId, reglaAprendida.id],
    }),
    check("regla_candidata_estado_valido", sql`${t.estado} IN (${lista(ESTADOS_CANDIDATA_BD)})`),
    check(
      "regla_candidata_destinos_validos",
      sql`(${t.destinoPropuesto} IS NULL OR ${t.destinoPropuesto} IN (${lista(DESTINOS_REGLA_BD)})) AND (${t.destinoElegido} IS NULL OR ${t.destinoElegido} IN (${lista(DESTINOS_REGLA_BD)}))`,
    ),
    check(
      "regla_candidata_documento_largo",
      sql`char_length(${t.docTipo}) BETWEEN 1 AND 2 AND char_length(${t.docNumero}) BETWEEN 1 AND 20`,
    ),
    check(
      "regla_candidata_conteos",
      sql`${t.nDg} >= 0 AND ${t.nDgng} >= 0 AND ${t.nDng} >= 0 AND ${t.nMixto} >= 0 AND ${t.nTotal} = ${t.nDg} + ${t.nDgng} + ${t.nDng} + ${t.nMixto} AND ${t.periodosConProveedor} >= 0`,
    ),
    check(
      "regla_candidata_umbral",
      sql`${t.destinoPropuesto} IS NULL OR (CASE ${t.destinoPropuesto} WHEN 'DG' THEN ${t.nDg} WHEN 'DGNG' THEN ${t.nDgng} ELSE ${t.nDng} END >= 2 AND 5 * CASE ${t.destinoPropuesto} WHEN 'DG' THEN ${t.nDg} WHEN 'DGNG' THEN ${t.nDgng} ELSE ${t.nDng} END >= 4 * ${t.nTotal})`,
    ),
    check(
      "regla_candidata_resolucion_coherente",
      sql`CASE WHEN ${t.estado} = 'pendiente' THEN ${t.reglaId} IS NULL AND ${t.resueltaPor} IS NULL AND ${t.resueltaEn} IS NULL ELSE ${t.resueltaEn} IS NOT NULL AND (${t.reglaId} IS NULL OR ${t.estado} = 'activada') END`,
    ),
    check(
      "regla_candidata_razon_social_valida",
      sql`${t.razonSocial} IS NULL OR (char_length(${t.razonSocial}) BETWEEN 1 AND 200 AND ${t.razonSocial} !~ ${CONTROLES_O_BIDI})`,
    ),
  ],
);

import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { membresia } from "./acceso";
import { cliente } from "./clientes";
import { id, tenantIdPorDefecto } from "./comun";
import { tenant } from "./plataforma";
import { propuesta } from "./propuestas";
import { documentoXml } from "./xml";

// Monto en soles o en la moneda del comprobante: NUMERIC(14,2), nunca doble precisión (CLAUDE.md).
const monto = (nombre: string) => numeric(nombre, { precision: 14, scale: 2 }).notNull();

// Spec 014 (D-1, D-2, D-9). Compras del RCE: la fila de identidad (`compra`) casi no cambia y cada edición es una versión nueva e
// inmutable (`compra_version`). RLS ENABLE + FORCE, tenant_isolation, grants mínimos y el trigger de identidad
// (`compra_identidad_inmutable`: solo `version_vigente` y `descartada_en`, de NULL a una fecha, una vez) están en 0032_compra,
// 0033_compra_hallazgo_periodo y 0034_compra_puntero_vigente. Va aparte del índice del esquema, como `ventas.ts`. Ninguna columna termina en `_at` (013: `_en`).
export const compra = pgTable(
  "compra",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .default(tenantIdPorDefecto)
      .references(() => tenant.id),
    clienteId: uuid("cliente_id").notNull(),
    periodo: char("periodo", { length: 6 }).notNull(),
    // NOT NULL si y solo si el origen es `sire` (una agregada a mano no cuelga de una propuesta).
    propuestaId: uuid("propuesta_id"),
    // `claveComprobante` (plan, «Clave»): `tipo|SERIE|numero|docTipo|DOC`.
    clave: text("clave").notNull(),
    tipoDoc: char("tipo_doc", { length: 2 }).notNull(),
    serie: varchar("serie", { length: 4 }).notNull(),
    numero: varchar("numero", { length: 20 }).notNull(),
    docTipo: text("doc_tipo").notNull(),
    docNumero: text("doc_numero").notNull(),
    // Texto no confiable (viene del SIRE o del usuario): acotado.
    razonSocial: text("razon_social"),
    fecha: date("fecha", { mode: "string" }).notNull(),
    moneda: text("moneda").notNull(),
    // Escala de TipoCambio (010 D7): hasta 4 enteros y 3 decimales.
    tipoCambio: numeric("tipo_cambio", { precision: 7, scale: 3 }),
    origen: text("origen").notNull(),
    // Puntero a la versión vigente; sin FK (la versión 1 se inserta en la misma transacción) y movido con compare-and-set.
    versionVigente: integer("version_vigente").notNull(),
    // Descartar una agregada: la clave queda libre (índice único parcial) y la fila se conserva.
    descartadaEn: timestamp("descartada_en", { withTimezone: true }),
    creadaEn: timestamp("creada_en", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Para las FK compuestas de las tablas hijas.
    unique("compra_tenant_id_unique").on(t.tenantId, t.id),
    // La clave solo es única entre las filas vivas: al descartar una agregada se puede volver a agregar (D-7).
    uniqueIndex("compra_clave_viva_unique")
      .on(t.tenantId, t.clienteId, t.periodo, t.clave)
      .where(sql`${t.descartadaEn} IS NULL`),
    foreignKey({
      name: "compra_cliente_fk",
      columns: [t.tenantId, t.clienteId],
      foreignColumns: [cliente.tenantId, cliente.id],
    }),
    foreignKey({
      name: "compra_propuesta_fk",
      columns: [t.tenantId, t.propuestaId],
      foreignColumns: [propuesta.tenantId, propuesta.id],
    }),
    index("compra_lectura_idx").on(t.clienteId, t.periodo, t.serie, t.numero),
    check("compra_periodo_formato", sql`${t.periodo} ~ '^[0-9]{4}(0[1-9]|1[0-2])$'`),
    check("compra_origen_valido", sql`${t.origen} IN ('sire', 'agregada')`),
    check("compra_moneda_valida", sql`${t.moneda} IN ('PEN', 'USD')`),
    // propuesta_id es nulo si y solo si el origen es `agregada`.
    check(
      "compra_propuesta_segun_origen",
      sql`(${t.origen} = 'agregada' AND ${t.propuestaId} IS NULL) OR (${t.origen} = 'sire' AND ${t.propuestaId} IS NOT NULL)`,
    ),
    check(
      "compra_tipo_cambio_valido",
      sql`${t.tipoCambio} IS NULL OR (${t.moneda} = 'USD' AND ${t.tipoCambio} > 0)`,
    ),
    check("compra_version_vigente_positiva", sql`${t.versionVigente} >= 1`),
    check("compra_razon_social_larga", sql`${t.razonSocial} IS NULL OR char_length(${t.razonSocial}) <= 200`),
  ],
);

// Cada edición crea una versión; la 1 es el original y nada se modifica ni se borra (solo SELECT/INSERT, D-2).
export const compraVersion = pgTable(
  "compra_version",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .default(tenantIdPorDefecto)
      .references(() => tenant.id),
    compraId: uuid("compra_id").notNull(),
    n: integer("n").notNull(),
    biDg: monto("bi_dg"),
    igvDg: monto("igv_dg"),
    biDgng: monto("bi_dgng"),
    igvDgng: monto("igv_dgng"),
    biDng: monto("bi_dng"),
    igvDng: monto("igv_dng"),
    noGravado: monto("no_gravado"),
    isc: monto("isc"),
    icbper: monto("icbper"),
    otrosTributos: monto("otros_tributos"),
    total: monto("total"),
    excluida: boolean("excluida").notNull().default(false),
    motivo: varchar("motivo", { length: 200 }),
    clasificada: boolean("clasificada").notNull().default(false),
    accion: text("accion").notNull(),
    operacionId: uuid("operacion_id"),
    usuarioId: uuid("usuario_id"),
    creadaEn: timestamp("creada_en", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("compra_version_compra_n_unique").on(t.tenantId, t.compraId, t.n),
    foreignKey({
      name: "compra_version_compra_fk",
      columns: [t.tenantId, t.compraId],
      foreignColumns: [compra.tenantId, compra.id],
    }),
    foreignKey({
      name: "compra_version_operacion_fk",
      columns: [t.tenantId, t.operacionId],
      foreignColumns: [compraOperacion.tenantId, compraOperacion.id],
    }),
    foreignKey({
      name: "compra_version_usuario_fk",
      columns: [t.tenantId, t.usuarioId],
      foreignColumns: [membresia.tenantId, membresia.usuarioId],
    }),
    // Deshacer busca las versiones que creó una operación.
    index("compra_version_operacion_idx").on(t.tenantId, t.operacionId),
    check("compra_version_n_positivo", sql`${t.n} >= 1`),
  ],
);

// Operación de un usuario sobre un periodo (clasificar, editar, masivas, deshacer, rehacer): base de la pila de deshacer.
// Solo `estado` y `deshecha_en` son mutables (grants por columna en 0032).
export const compraOperacion = pgTable(
  "compra_operacion",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .default(tenantIdPorDefecto)
      .references(() => tenant.id),
    clienteId: uuid("cliente_id").notNull(),
    periodo: char("periodo", { length: 6 }).notNull(),
    usuarioId: uuid("usuario_id").notNull(),
    tipo: text("tipo").notNull(),
    estado: text("estado").notNull(),
    // Para `deshacer`/`rehacer`: la operación que se deshizo o se rehízo.
    referenciaId: uuid("referencia_id"),
    creadaEn: timestamp("creada_en", { withTimezone: true }).notNull().defaultNow(),
    deshechaEn: timestamp("deshecha_en", { withTimezone: true }),
  },
  (t) => [
    unique("compra_operacion_tenant_id_unique").on(t.tenantId, t.id),
    foreignKey({
      name: "compra_operacion_cliente_fk",
      columns: [t.tenantId, t.clienteId],
      foreignColumns: [cliente.tenantId, cliente.id],
    }),
    foreignKey({
      name: "compra_operacion_usuario_fk",
      columns: [t.tenantId, t.usuarioId],
      foreignColumns: [membresia.tenantId, membresia.usuarioId],
    }),
    // Pila de deshacer por usuario y periodo.
    index("compra_operacion_pila_idx").on(t.tenantId, t.clienteId, t.periodo, t.usuarioId, t.creadaEn),
    check("compra_operacion_periodo_formato", sql`${t.periodo} ~ '^[0-9]{4}(0[1-9]|1[0-2])$'`),
    check("compra_operacion_estado_valido", sql`${t.estado} IN ('vigente', 'deshecha', 'caducada')`),
  ],
);

// Spec 016 (D-5, P-2), migración 0036_compra_evaluacion. Evaluación numerada de una versión: cada versión nueva nace con la
// evaluación 1 y la llegada de un XML agrega la n + 1 de la versión vigente, sin crear versión ni mover el puntero. Solo
// inserción. `documento_xml_id` es el XML vigente con el que se evaluó (nulo: sin XML).
export const compraEvaluacion = pgTable(
  "compra_evaluacion",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .default(tenantIdPorDefecto)
      .references(() => tenant.id),
    compraId: uuid("compra_id").notNull(),
    versionN: integer("version_n").notNull(),
    n: integer("n").notNull(),
    documentoXmlId: uuid("documento_xml_id"),
    creadaEn: timestamp("creada_en", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // También sirve para buscar la última evaluación de una versión (recorrido inverso del índice).
    unique("compra_evaluacion_version_n_unique").on(t.tenantId, t.compraId, t.versionN, t.n),
    foreignKey({
      name: "compra_evaluacion_version_fk",
      columns: [t.tenantId, t.compraId, t.versionN],
      foreignColumns: [compraVersion.tenantId, compraVersion.compraId, compraVersion.n],
    }),
    foreignKey({
      name: "compra_evaluacion_documento_xml_fk",
      columns: [t.tenantId, t.documentoXmlId],
      foreignColumns: [documentoXml.tenantId, documentoXml.id],
    }),
    check("compra_evaluacion_n_positivo", sql`${t.n} >= 1`),
  ],
);

// Hallazgos de las reglas de una evaluación de una versión: solo inserción. Los vigentes de una fila son los de la última
// evaluación de su versión vigente (016 D-5).
export const compraHallazgo = pgTable(
  "compra_hallazgo",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .default(tenantIdPorDefecto)
      .references(() => tenant.id),
    compraId: uuid("compra_id").notNull(),
    versionN: integer("version_n").notNull(),
    // 016: la evaluación de la versión a la que pertenece (0036 la agrega con DEFAULT 1 para las filas existentes y lo quita).
    evaluacionN: integer("evaluacion_n").notNull(),
    regla: text("regla").notNull(),
    sugerencia: jsonb("sugerencia"),
    lecturas: jsonb("lecturas").notNull(),
    requiereConfirmacion: boolean("requiere_confirmacion").notNull(),
    creadaEn: timestamp("creada_en", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("compra_hallazgo_evaluacion_regla_unique").on(t.tenantId, t.compraId, t.versionN, t.evaluacionN, t.regla),
    foreignKey({
      name: "compra_hallazgo_compra_fk",
      columns: [t.tenantId, t.compraId],
      foreignColumns: [compra.tenantId, compra.id],
    }),
    foreignKey({
      name: "compra_hallazgo_evaluacion_fk",
      columns: [t.tenantId, t.compraId, t.versionN, t.evaluacionN],
      foreignColumns: [compraEvaluacion.tenantId, compraEvaluacion.compraId, compraEvaluacion.versionN, compraEvaluacion.n],
    }),
    check("compra_hallazgo_version_positiva", sql`${t.versionN} >= 1`),
    check("compra_hallazgo_evaluacion_positiva", sql`${t.evaluacionN} >= 1`),
  ],
);

// Estado del periodo de compras (abierto, revisado, generado). La ausencia de fila equivale a `abierto`. Cambia con
// compare-and-set; `FOR SHARE` de las acciones exige UPDATE de columnas, por eso los dos roles lo tienen (0033).
export const compraPeriodo = pgTable(
  "compra_periodo",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .default(tenantIdPorDefecto)
      .references(() => tenant.id),
    clienteId: uuid("cliente_id").notNull(),
    periodo: char("periodo", { length: 6 }).notNull(),
    estado: text("estado").notNull(),
    marcadoPor: uuid("marcado_por"),
    marcadoEn: timestamp("marcado_en", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ name: "compra_periodo_pk", columns: [t.tenantId, t.clienteId, t.periodo] }),
    foreignKey({
      name: "compra_periodo_cliente_fk",
      columns: [t.tenantId, t.clienteId],
      foreignColumns: [cliente.tenantId, cliente.id],
    }),
    foreignKey({
      name: "compra_periodo_marcado_por_fk",
      columns: [t.tenantId, t.marcadoPor],
      foreignColumns: [membresia.tenantId, membresia.usuarioId],
    }),
    check("compra_periodo_periodo_formato", sql`${t.periodo} ~ '^[0-9]{4}(0[1-9]|1[0-2])$'`),
    check("compra_periodo_estado_valido", sql`${t.estado} IN ('abierto', 'revisado', 'generado')`),
  ],
);

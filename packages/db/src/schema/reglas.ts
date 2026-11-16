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
import { tenant } from "./plataforma";

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
export const CODIGOS_REGLA_MOTOR_BD = ["R-ISC", "R-MIX", "R-RED", "R-NEW", "R-GP", "R-HIS"] as const;

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

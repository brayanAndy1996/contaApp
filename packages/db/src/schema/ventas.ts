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

// Monto en soles o en la moneda del comprobante: NUMERIC(14,2), nunca doble precisión (CLAUDE.md).
const monto = (nombre: string) => numeric(nombre, { precision: 14, scale: 2 }).notNull();

// Spec 013 (D1, D4, D14b, D15, D17). Fila de venta del RVIE. RLS, grants y el trigger que la hace inmutable
// (`venta_inmutable`: ningún UPDATE, DELETE solo de filas `manual`) están en 0030_venta. Va aparte del índice del esquema.
export const venta = pgTable(
  "venta",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .default(tenantIdPorDefecto)
      .references(() => tenant.id),
    clienteId: uuid("cliente_id").notNull(),
    periodo: char("periodo", { length: 6 }).notNull(),
    // Nulo si y solo si el origen es `manual`.
    propuestaId: uuid("propuesta_id"),
    origen: text("origen").notNull(),
    // Clave normalizada (D17): `tipo|SERIE|numero sin ceros a la izquierda`.
    clave: text("clave").notNull(),
    tipo: char("tipo", { length: 2 }).notNull(),
    serie: varchar("serie", { length: 4 }).notNull(),
    numero: varchar("numero", { length: 20 }).notNull(),
    // Entero si `numero` tiene de 1 a 8 dígitos; nulo si no es evaluable (correlatividad, D7).
    numeroN: integer("numero_n"),
    fecha: date("fecha", { mode: "string" }).notNull(),
    tipoDocContraparte: text("tipo_doc_contraparte").notNull(),
    docContraparte: text("doc_contraparte").notNull(),
    moneda: text("moneda").notNull(),
    // Escala de TipoCambio (010 D7): hasta 4 enteros y 3 decimales.
    tipoCambio: numeric("tipo_cambio", { precision: 7, scale: 3 }),
    baseGravada: monto("base_gravada"),
    igv: monto("igv"),
    exonerada: monto("exonerada"),
    inafecta: monto("inafecta"),
    isc: monto("isc"),
    icbper: monto("icbper"),
    otros: monto("otros"),
    total: monto("total"),
    creadaPor: uuid("creada_por"),
    creadaEn: timestamp("creada_en", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("venta_cliente_periodo_clave_unique").on(t.tenantId, t.clienteId, t.periodo, t.clave),
    foreignKey({
      name: "venta_cliente_fk",
      columns: [t.tenantId, t.clienteId],
      foreignColumns: [cliente.tenantId, cliente.id],
    }),
    // 014 reutiliza `propuesta` con la misma FK compuesta desde `compra`.
    foreignKey({
      name: "venta_propuesta_fk",
      columns: [t.tenantId, t.propuestaId],
      foreignColumns: [propuesta.tenantId, propuesta.id],
    }),
    foreignKey({
      name: "venta_creada_por_fk",
      columns: [t.tenantId, t.creadaPor],
      foreignColumns: [membresia.tenantId, membresia.usuarioId],
    }),
    index("venta_lectura_idx").on(t.clienteId, t.periodo, t.tipo, t.serie, t.numeroN),
    // Spec 012b (0039): destino de la FK compuesta de `venta_exclusion`. Índice único, sin tocar las filas.
    uniqueIndex("venta_tenant_id_unique").on(t.tenantId, t.id),
    check("venta_periodo_formato", sql`${t.periodo} ~ '^[0-9]{4}(0[1-9]|1[0-2])$'`),
    check("venta_origen_valido", sql`${t.origen} IN ('sire', 'manual')`),
    check("venta_moneda_valida", sql`${t.moneda} IN ('PEN', 'USD')`),
    // propuesta_id es nulo si y solo si el origen es `manual` (D4).
    check(
      "venta_propuesta_segun_origen",
      sql`(${t.origen} = 'manual' AND ${t.propuestaId} IS NULL) OR (${t.origen} = 'sire' AND ${t.propuestaId} IS NOT NULL)`,
    ),
    // El tipo de cambio solo existe en USD y es positivo (una USD puede llegar sin él: va a `sinConvertir`).
    check(
      "venta_tipo_cambio_valido",
      sql`${t.tipoCambio} IS NULL OR (${t.moneda} = 'USD' AND ${t.tipoCambio} > 0)`,
    ),
    // numero_n coincide con numero cuando este tiene de 1 a 8 dígitos y es nulo en los demás casos.
    check(
      "venta_numero_n_coherente",
      sql`CASE WHEN ${t.numero} ~ '^[0-9]{1,8}$' THEN ${t.numeroN} IS NULL OR ${t.numeroN} = ${t.numero}::integer ELSE ${t.numeroN} IS NULL END`,
    ),
  ],
);

// Spec 013 (D8): salto de numeración justificado por el contador. Revertir solo escribe `revertido_*` (el registro
// se conserva). RLS y grants (UPDATE solo de las columnas `revertido_*`) están en 0031_venta_salto_justificado.
export const ventaSaltoJustificado = pgTable(
  "venta_salto_justificado",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .default(tenantIdPorDefecto)
      .references(() => tenant.id),
    clienteId: uuid("cliente_id").notNull(),
    periodo: char("periodo", { length: 6 }).notNull(),
    tipo: char("tipo", { length: 2 }).notNull(),
    serie: varchar("serie", { length: 4 }).notNull(),
    desde: integer("desde").notNull(),
    hasta: integer("hasta").notNull(),
    comentario: text("comentario").notNull(),
    usuarioId: uuid("usuario_id").notNull(),
    creadaEn: timestamp("creada_en", { withTimezone: true }).notNull().defaultNow(),
    revertidoPor: uuid("revertido_por"),
    revertidoEn: timestamp("revertido_en", { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: "venta_salto_justificado_cliente_fk",
      columns: [t.tenantId, t.clienteId],
      foreignColumns: [cliente.tenantId, cliente.id],
    }),
    foreignKey({
      name: "venta_salto_justificado_usuario_fk",
      columns: [t.tenantId, t.usuarioId],
      foreignColumns: [membresia.tenantId, membresia.usuarioId],
    }),
    foreignKey({
      name: "venta_salto_justificado_revertido_por_fk",
      columns: [t.tenantId, t.revertidoPor],
      foreignColumns: [membresia.tenantId, membresia.usuarioId],
    }),
    // Dos justificaciones iguales a la vez dejan una sola vigente; las revertidas se acumulan.
    uniqueIndex("venta_salto_justificado_vigente_unique")
      .on(t.tenantId, t.clienteId, t.periodo, t.tipo, t.serie, t.desde, t.hasta)
      .where(sql`${t.revertidoEn} IS NULL`),
    check("venta_salto_justificado_periodo_formato", sql`${t.periodo} ~ '^[0-9]{4}(0[1-9]|1[0-2])$'`),
    check(
      "venta_salto_justificado_rango_valido",
      sql`${t.desde} BETWEEN 1 AND 99999999 AND ${t.hasta} BETWEEN 1 AND 99999999 AND ${t.desde} <= ${t.hasta}`,
    ),
    check(
      "venta_salto_justificado_comentario_largo",
      sql`char_length(${t.comentario}) BETWEEN 1 AND 500`,
    ),
    // Revertir escribe quien y cuándo juntos.
    check(
      "venta_salto_justificado_reversion_completa",
      sql`(${t.revertidoPor} IS NULL) = (${t.revertidoEn} IS NULL)`,
    ),
  ],
);

// Spec 012b (P-1, P-9, D5): estado del periodo de ventas, igual a `compra_periodo` (sin fila equivale a `abierto`). RLS, grants
// (UPDATE solo de estado y marca) y el trigger `periodo_worker_acotado` del worker están en 0039_venta_periodo_exclusion.
export const ventaPeriodo = pgTable(
  "venta_periodo",
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
    primaryKey({ name: "venta_periodo_pk", columns: [t.tenantId, t.clienteId, t.periodo] }),
    foreignKey({
      name: "venta_periodo_cliente_fk",
      columns: [t.tenantId, t.clienteId],
      foreignColumns: [cliente.tenantId, cliente.id],
    }),
    foreignKey({
      name: "venta_periodo_marcado_por_fk",
      columns: [t.tenantId, t.marcadoPor],
      foreignColumns: [membresia.tenantId, membresia.usuarioId],
    }),
    check("venta_periodo_periodo_formato", sql`${t.periodo} ~ '^[0-9]{4}(0[1-9]|1[0-2])$'`),
    check("venta_periodo_estado_valido", sql`${t.estado} IN ('abierto', 'revisado', 'generado')`),
  ],
);

// Spec 012b (P-8, D12): exclusión de una venta del SIRE con error. Solo inserción; restaurar cierra la vigente escribiendo
// `restaurada_*` (el registro se conserva). Una sola vigente por venta. RLS, grants y triggers en 0039_venta_periodo_exclusion.
export const ventaExclusion = pgTable(
  "venta_exclusion",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .default(tenantIdPorDefecto)
      .references(() => tenant.id),
    clienteId: uuid("cliente_id").notNull(),
    periodo: char("periodo", { length: 6 }).notNull(),
    ventaId: uuid("venta_id").notNull(),
    motivo: text("motivo").notNull(),
    excluidaPor: uuid("excluida_por").notNull(),
    excluidaEn: timestamp("excluida_en", { withTimezone: true }).notNull().defaultNow(),
    restauradaPor: uuid("restaurada_por"),
    restauradaEn: timestamp("restaurada_en", { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: "venta_exclusion_cliente_fk",
      columns: [t.tenantId, t.clienteId],
      foreignColumns: [cliente.tenantId, cliente.id],
    }),
    foreignKey({
      name: "venta_exclusion_venta_fk",
      columns: [t.tenantId, t.ventaId],
      foreignColumns: [venta.tenantId, venta.id],
    }),
    foreignKey({
      name: "venta_exclusion_excluida_por_fk",
      columns: [t.tenantId, t.excluidaPor],
      foreignColumns: [membresia.tenantId, membresia.usuarioId],
    }),
    foreignKey({
      name: "venta_exclusion_restaurada_por_fk",
      columns: [t.tenantId, t.restauradaPor],
      foreignColumns: [membresia.tenantId, membresia.usuarioId],
    }),
    // Una sola exclusión vigente por venta (dos a la vez: una entra, la otra 23505 o nada con ON CONFLICT).
    uniqueIndex("venta_exclusion_vigente_unique")
      .on(t.tenantId, t.ventaId)
      .where(sql`${t.restauradaEn} IS NULL`),
    index("venta_exclusion_cliente_periodo_idx").on(t.clienteId, t.periodo),
    check("venta_exclusion_periodo_formato", sql`${t.periodo} ~ '^[0-9]{4}(0[1-9]|1[0-2])$'`),
    check("venta_exclusion_motivo_largo", sql`char_length(${t.motivo}) BETWEEN 1 AND 200`),
    // Restaurar escribe quién y cuándo juntos.
    check(
      "venta_exclusion_restauracion_completa",
      sql`(${t.restauradaPor} IS NULL) = (${t.restauradaEn} IS NULL)`,
    ),
  ],
);

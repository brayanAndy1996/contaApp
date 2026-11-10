import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  char,
  check,
  customType,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { membresia } from "./acceso";
import { cliente } from "./clientes";
import { id, tenantIdPorDefecto } from "./comun";
import { tenant } from "./plataforma";

// bytea <-> Buffer (pg ya devuelve Buffer para bytea; sin conversión adicional).
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

// Identidad del comprobante como `text` acotado (no varchar: un mismo parámetro sirve para insertar y para comparar sin que
// PostgreSQL deduzca tipos distintos). Largos de `compra` (serie 4, número 20) y documento hasta 20.
const identidadAcotada = (t: {
  rucEmisor: AnyPgColumn;
  serie: AnyPgColumn;
  numero: AnyPgColumn;
}) =>
  sql`char_length(${t.rucEmisor}) BETWEEN 1 AND 20 AND char_length(${t.serie}) BETWEEN 1 AND 4 AND char_length(${t.numero}) BETWEEN 1 AND 20`;

// Spec 016 (D-4, D-10), migración 0035_documento_xml. El XML de un comprobante por (cliente, RUC emisor, tipo, serie, número), no
// por compra: sobrevive a descartar y volver a agregar. Solo inserción: el vigente es el de mayor `n` y los anteriores se
// conservan (P-6). Identidad normalizada como la `clave` de 014 (serie en mayúsculas, número sin ceros a la izquierda). RLS
// ENABLE + FORCE, tenant_isolation y grants (SELECT/INSERT a backend y worker) en la migración. Ninguna columna termina en `_at`.
export const documentoXml = pgTable(
  "documento_xml",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .default(tenantIdPorDefecto)
      .references(() => tenant.id),
    clienteId: uuid("cliente_id").notNull(),
    rucEmisor: text("ruc_emisor").notNull(),
    tipo: char("tipo", { length: 2 }).notNull(),
    serie: text("serie").notNull(),
    numero: text("numero").notNull(),
    n: integer("n").notNull(),
    origen: text("origen").notNull(),
    // `xml/{tenant}/{cliente}/{uuid}.xml`: nunca el nombre del archivo subido (D-4).
    ruta: text("ruta").notNull(),
    sha256: bytea("sha256").notNull(),
    tamano: integer("tamano").notNull(),
    // `DetalleXml` del parser de `domain`: la lupa lo lee sin re-parsear (CA-18).
    detalle: jsonb("detalle").notNull(),
    subidoPor: uuid("subido_por"),
    creadaEn: timestamp("creada_en", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Para la FK compuesta de `compra_evaluacion`.
    unique("documento_xml_tenant_id_unique").on(t.tenantId, t.id),
    unique("documento_xml_comprobante_n_unique").on(
      t.tenantId,
      t.clienteId,
      t.rucEmisor,
      t.tipo,
      t.serie,
      t.numero,
      t.n,
    ),
    foreignKey({
      name: "documento_xml_cliente_fk",
      columns: [t.tenantId, t.clienteId],
      foreignColumns: [cliente.tenantId, cliente.id],
    }),
    foreignKey({
      name: "documento_xml_subido_por_fk",
      columns: [t.tenantId, t.subidoPor],
      foreignColumns: [membresia.tenantId, membresia.usuarioId],
    }),
    check("documento_xml_identidad_larga", identidadAcotada(t)),
    check(
      "documento_xml_origen_valido",
      sql`${t.origen} IN ('simulado', 'real', 'subido')`,
    ),
    check(
      "documento_xml_subido_por_segun_origen",
      sql`(${t.origen} = 'subido') = (${t.subidoPor} IS NOT NULL)`,
    ),
    check(
      "documento_xml_tamano_valido",
      sql`${t.tamano} >= 1 AND ${t.tamano} <= 1048576`,
    ),
    check("documento_xml_n_positivo", sql`${t.n} >= 1`),
    check("documento_xml_sha256_largo", sql`octet_length(${t.sha256}) = 32`),
    check(
      "documento_xml_ruta_formato",
      sql`${t.ruta} ~ '^xml/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\\.xml$'`,
    ),
  ],
);

// Estado de obtención por comprobante (D-4): distingue «pendiente» de «no disponible» en la lupa. Única tabla de 016 con UPDATE
// (backend y worker); sin DELETE.
export const documentoXmlObtencion = pgTable(
  "documento_xml_obtencion",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .default(tenantIdPorDefecto)
      .references(() => tenant.id),
    clienteId: uuid("cliente_id").notNull(),
    rucEmisor: text("ruc_emisor").notNull(),
    tipo: char("tipo", { length: 2 }).notNull(),
    serie: text("serie").notNull(),
    numero: text("numero").notNull(),
    estado: text("estado").notNull(),
    intentos: integer("intentos").notNull().default(0),
    actualizadoEn: timestamp("actualizado_en", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({
      name: "documento_xml_obtencion_pk",
      columns: [
        t.tenantId,
        t.clienteId,
        t.rucEmisor,
        t.tipo,
        t.serie,
        t.numero,
      ],
    }),
    foreignKey({
      name: "documento_xml_obtencion_cliente_fk",
      columns: [t.tenantId, t.clienteId],
      foreignColumns: [cliente.tenantId, cliente.id],
    }),
    check("documento_xml_obtencion_identidad_larga", identidadAcotada(t)),
    check(
      "documento_xml_obtencion_estado_valido",
      sql`${t.estado} IN ('pendiente', 'no_encontrado', 'credencial', 'transitorio')`,
    ),
    check("documento_xml_obtencion_intentos_validos", sql`${t.intentos} >= 0`),
  ],
);

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { cliente } from "./clientes";
import { id, tenantIdPorDefecto } from "./comun";
import { tenant } from "./plataforma";

// Spec 023 (D-3, D-4, D-5, P-10). Buzón SOL: estado de captura por cliente, metadatos de cada mensaje y sus adjuntos (solo al
// abrir). RLS ENABLE + FORCE, tenant_isolation, grants por columna, triggers y funciones acotadas en 0054–0056. Va aparte del
// índice del esquema, como 014–021. `buzon_programacion` (0055) es la fila única del candado del ciclo del programador: sin
// tenant_id y sin ningún privilegio para los roles de la app (solo la tocan las funciones sistema.buzon_ciclo_*).

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

const tenantId = () =>
  uuid("tenant_id")
    .notNull()
    .default(tenantIdPorDefecto)
    .references(() => tenant.id);

/** Categorías de `buzon_mensaje` (las de `CATEGORIAS_BUZON` de shared). */
export const CATEGORIAS_BUZON_BD = [
  "coactiva",
  "resolucion_determinacion",
  "resolucion_multa",
  "requerimiento_fiscalizacion",
  "otro",
] as const;
export const MOTIVOS_CRITICO_BUZON_BD = ["codigo", "asunto", "duda"] as const;
export const MOTIVOS_OMITIDO_BUZON_BD = ["mime", "tamano", "tope_mensaje"] as const;

const lista = (valores: readonly string[]) => sql.raw(valores.map((v) => `'${v}'`).join(", "));

/** Ruta de storage de la propia fila: 'buzon/{tenant}/{cliente}/{uuid}.{ext}' (sin nombres originales ni escapes). */
const rutaDeLaFila = (ruta: unknown, tenant: unknown, clienteId: unknown) =>
  sql`${ruta} ~ ('^buzon/' || ${tenant}::text || '/' || ${clienteId}::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.][a-z0-9]{1,10}$')`;

// 0054. Una fila por cliente (perezosa: la crean el worker, encolar_buzon_programados o buzon_estado_bloquear).
export const buzonEstadoCliente = pgTable(
  "buzon_estado_cliente",
  {
    tenantId: tenantId(),
    clienteId: uuid("cliente_id").notNull(),
    ultimaProgramadaEn: timestamp("ultima_programada_en", { withTimezone: true }),
    ultimaSolicitudEn: timestamp("ultima_solicitud_en", { withTimezone: true }),
    ultimaCapturaEn: timestamp("ultima_captura_en", { withTimezone: true }),
    sincronizadoEn: timestamp("sincronizado_en", { withTimezone: true }),
    cursorPendiente: text("cursor_pendiente"),
  },
  (t) => [
    primaryKey({ name: "buzon_estado_cliente_pk", columns: [t.tenantId, t.clienteId] }),
    foreignKey({
      name: "buzon_estado_cliente_cliente_fk",
      columns: [t.tenantId, t.clienteId],
      foreignColumns: [cliente.tenantId, cliente.id],
    }),
    check("buzon_estado_cliente_cursor_largo", sql`char_length(${t.cursorPendiente}) <= 200`),
  ],
);

// 0054. Metadatos de un mensaje (la captura nunca abre el contenido). La categoría, el crítico y el aviso los decide el dominio
// al insertar y no cambian después (trigger buzon_mensaje_inmutable); el contenido se fija una sola vez al abrir.
export const buzonMensaje = pgTable(
  "buzon_mensaje",
  {
    id: id(),
    tenantId: tenantId(),
    clienteId: uuid("cliente_id").notNull(),
    idSunat: text("id_sunat").notNull(),
    asunto: text("asunto").notNull(),
    remitente: text("remitente").notNull(),
    fecha: timestamp("fecha", { withTimezone: true }).notNull(),
    codigoTipo: text("codigo_tipo"),
    categoria: text("categoria").notNull(),
    critico: boolean("critico").notNull(),
    motivoCritico: text("motivo_critico"),
    versionCatalogo: integer("version_catalogo").notNull(),
    avisado: boolean("avisado").notNull().default(false),
    leidoSunat: boolean("leido_sunat").notNull().default(false),
    primeraCapturaEn: timestamp("primera_captura_en", { withTimezone: true }).notNull().defaultNow(),
    ultimaCapturaEn: timestamp("ultima_captura_en", { withTimezone: true }).notNull().defaultNow(),
    adjuntosDeclarados: smallint("adjuntos_declarados").notNull().default(0),
    contenidoRuta: text("contenido_ruta"),
    contenidoBytes: integer("contenido_bytes"),
    contenidoObtenidoEn: timestamp("contenido_obtenido_en", { withTimezone: true }),
  },
  (t) => [
    unique("buzon_mensaje_id_sunat_unique").on(t.tenantId, t.clienteId, t.idSunat),
    unique("buzon_mensaje_cliente_id_unique").on(t.tenantId, t.clienteId, t.id),
    foreignKey({
      name: "buzon_mensaje_cliente_fk",
      columns: [t.tenantId, t.clienteId],
      foreignColumns: [cliente.tenantId, cliente.id],
    }),
    index("buzon_mensaje_lista_idx").on(t.tenantId, t.clienteId, t.fecha.desc(), t.id.desc()),
    check("buzon_mensaje_id_sunat_largo", sql`char_length(${t.idSunat}) BETWEEN 1 AND 64`),
    check("buzon_mensaje_asunto_largo", sql`char_length(${t.asunto}) <= 500`),
    check("buzon_mensaje_remitente_largo", sql`char_length(${t.remitente}) <= 200`),
    check("buzon_mensaje_codigo_tipo_largo", sql`char_length(${t.codigoTipo}) <= 32`),
    check("buzon_mensaje_categoria_valida", sql`${t.categoria} IN (${lista(CATEGORIAS_BUZON_BD)})`),
    check("buzon_mensaje_motivo_valido", sql`${t.motivoCritico} IN (${lista(MOTIVOS_CRITICO_BUZON_BD)})`),
    check("buzon_mensaje_avisado_critico", sql`NOT ${t.avisado} OR ${t.critico}`),
    check("buzon_mensaje_version_positiva", sql`${t.versionCatalogo} >= 1`),
    check("buzon_mensaje_adjuntos_no_negativo", sql`${t.adjuntosDeclarados} >= 0`),
    check(
      "buzon_mensaje_contenido_coherente",
      sql`(${t.contenidoRuta} IS NULL) = (${t.contenidoBytes} IS NULL) AND (${t.contenidoRuta} IS NULL) = (${t.contenidoObtenidoEn} IS NULL) AND (${t.contenidoBytes} IS NULL OR ${t.contenidoBytes} >= 0)`,
    ),
    check("buzon_mensaje_contenido_ruta", rutaDeLaFila(t.contenidoRuta, t.tenantId, t.clienteId)),
  ],
);

// 0054. Adjunto de un mensaje abierto: guardado (mime, tamaño, sha256 y ruta) u omitido con su motivo (sin nada de eso).
export const buzonAdjunto = pgTable(
  "buzon_adjunto",
  {
    id: id(),
    tenantId: tenantId(),
    clienteId: uuid("cliente_id").notNull(),
    mensajeId: uuid("mensaje_id").notNull(),
    idSunat: text("id_sunat").notNull(),
    nombre: text("nombre").notNull(),
    mime: text("mime"),
    tamano: bigint("tamano", { mode: "number" }),
    sha256: bytea("sha256"),
    ruta: text("ruta"),
    omitido: text("omitido"),
    creadoEn: timestamp("creado_en", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("buzon_adjunto_id_sunat_unique").on(t.tenantId, t.mensajeId, t.idSunat),
    foreignKey({
      name: "buzon_adjunto_mensaje_fk",
      columns: [t.tenantId, t.clienteId, t.mensajeId],
      foreignColumns: [buzonMensaje.tenantId, buzonMensaje.clienteId, buzonMensaje.id],
    }),
    foreignKey({
      name: "buzon_adjunto_cliente_fk",
      columns: [t.tenantId, t.clienteId],
      foreignColumns: [cliente.tenantId, cliente.id],
    }),
    check("buzon_adjunto_id_sunat_largo", sql`char_length(${t.idSunat}) BETWEEN 1 AND 64`),
    check("buzon_adjunto_nombre_largo", sql`char_length(${t.nombre}) BETWEEN 1 AND 255`),
    check("buzon_adjunto_mime_largo", sql`char_length(${t.mime}) BETWEEN 1 AND 100`),
    check("buzon_adjunto_omitido_valido", sql`${t.omitido} IN (${lista(MOTIVOS_OMITIDO_BUZON_BD)})`),
    check(
      "buzon_adjunto_guardado_u_omitido",
      sql`(${t.omitido} IS NULL AND ${t.ruta} IS NOT NULL AND ${t.mime} IS NOT NULL AND ${t.tamano} IS NOT NULL AND ${t.sha256} IS NOT NULL) OR (${t.omitido} IS NOT NULL AND ${t.ruta} IS NULL AND ${t.mime} IS NULL AND ${t.tamano} IS NULL AND ${t.sha256} IS NULL)`,
    ),
    check("buzon_adjunto_tamano_no_negativo", sql`${t.tamano} >= 0`),
    check("buzon_adjunto_sha256_largo", sql`octet_length(${t.sha256}) = 32`),
    check("buzon_adjunto_ruta", rutaDeLaFila(t.ruta, t.tenantId, t.clienteId)),
  ],
);

// 0055. Fila única del candado del ciclo del programador (todo el tiempo sale del reloj de la BD).
export const buzonProgramacion = pgTable(
  "buzon_programacion",
  {
    id: smallint("id").primaryKey().default(1),
    intervaloMin: integer("intervalo_min").notNull().default(15),
    reservaInteractiva: integer("reserva_interactiva").notNull().default(50),
    loteEstudio: integer("lote_estudio").notNull().default(1000),
    cicloDueno: text("ciclo_dueno"),
    cicloHasta: timestamp("ciclo_hasta", { withTimezone: true }),
    ultimoCicloInicio: timestamp("ultimo_ciclo_inicio", { withTimezone: true }),
    ultimoCicloFin: timestamp("ultimo_ciclo_fin", { withTimezone: true }),
  },
  (t) => [
    check("buzon_programacion_fila_unica", sql`${t.id} = 1`),
    check("buzon_programacion_intervalo", sql`${t.intervaloMin} BETWEEN 5 AND 120`),
    check("buzon_programacion_reserva", sql`${t.reservaInteractiva} >= 0`),
    check("buzon_programacion_lote", sql`${t.loteEstudio} BETWEEN 1 AND 10000`),
    check("buzon_programacion_dueno_largo", sql`char_length(${t.cicloDueno}) BETWEEN 1 AND 100`),
  ],
);

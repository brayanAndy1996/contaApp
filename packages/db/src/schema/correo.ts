import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { membresia } from "./acceso";
import { id, tenantIdPorDefecto } from "./comun";
import { notificacion } from "./notificaciones";
import { tenant } from "./plataforma";

// Spec 028 (R-11, R-14, R-15, D-2, D-7). Avisos por correo y resumen diario: preferencias por (estudio, usuario, tipo), envíos (uno por
// correo, sin su texto), avisos de cada envío (o diferidos por el tope), tokens de baja (solo su hash) y la fila única del ciclo. Nadie
// de la app escribe directo: escriben `interno.notificar` (contapp_registrador, en la transacción del hecho) y las funciones acotadas de
// 0074. RLS ENABLE + FORCE, políticas y grants en 0073. Va aparte del índice del esquema, como 014–027. Ninguna columna termina en `_at`.

/** Los cuatro tipos de correo (`TIPOS_CORREO` de shared). */
export const TIPOS_CORREO_BD = ["buzon_critico", "credencial_invalida", "plan_limite", "resumen"] as const;
/** Los tres tipos de aviso inmediato (U-1); `trabajo_terminado` nunca va por correo. */
export const TIPOS_AVISO_CORREO_BD = ["buzon_critico", "credencial_invalida", "plan_limite"] as const;
export const ORIGENES_ENVIO_BD = ["aviso", "resumen", "pendientes"] as const;
export const ESTADOS_ENVIO_BD = ["pendiente", "enviado", "omitido", "fallido"] as const;
/** Motivos de `omitido` (R-3); `fallido` solo lleva `transporte` (R-9). */
export const MOTIVOS_OMITIDO_BD = [
  "membresia_inactiva",
  "sin_correo",
  "preferencia_apagada",
  "sin_plan",
  "sin_contenido",
  "sin_novedades",
  // 0076 (H-028-2-7): resumen que al enviarse ya no es de su día de Lima (R-5).
  "fuera_de_dia",
] as const;

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

const lista = (valores: readonly string[]) => sql.raw(valores.map((v) => `'${v}'`).join(", "));

const tenantId = () =>
  uuid("tenant_id")
    .notNull()
    .default(tenantIdPorDefecto)
    .references(() => tenant.id);

// 0073. Preferencia explícita (sin fila rige la inicial por rol, R-15). «Todos los clientes» solo en la fila `resumen`.
export const correoPreferencia = pgTable(
  "correo_preferencia",
  {
    tenantId: tenantId(),
    usuarioId: uuid("usuario_id").notNull(),
    tipo: text("tipo").notNull(),
    activo: boolean("activo").notNull(),
    todosClientes: boolean("todos_clientes").notNull().default(false),
    actualizadaEn: timestamp("actualizada_en", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({ name: "correo_preferencia_pk", columns: [t.tenantId, t.usuarioId, t.tipo] }),
    foreignKey({
      name: "correo_preferencia_membresia_fk",
      columns: [t.tenantId, t.usuarioId],
      foreignColumns: [membresia.tenantId, membresia.usuarioId],
    }).onDelete("cascade"),
    check("correo_preferencia_tipo_valido", sql`${t.tipo} IN (${lista(TIPOS_CORREO_BD)})`),
    check("correo_preferencia_todos_solo_resumen", sql`NOT ${t.todosClientes} OR ${t.tipo} = 'resumen'`),
  ],
);

// 0073. Un correo (aviso agrupado, resumen del día o avisos pendientes del día). Sin destinatario, asunto ni texto (R-8, R-11).
export const correoEnvio = pgTable(
  "correo_envio",
  {
    id: id(),
    tenantId: tenantId(),
    usuarioId: uuid("usuario_id").notNull(),
    origen: text("origen").notNull(),
    tipo: text("tipo").notNull(),
    estado: text("estado").notNull().default("pendiente"),
    motivo: text("motivo"),
    clave: text("clave").notNull(),
    programadoPara: timestamp("programado_para", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
    tomadoEn: timestamp("tomado_en", { withTimezone: true }),
    intentos: smallint("intentos").notNull().default(0),
    totalAvisos: integer("total_avisos").notNull().default(0),
    diaLima: date("dia_lima"),
    corteHasta: timestamp("corte_hasta", { withTimezone: true }),
    creadoEn: timestamp("creado_en", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
    enviadoEn: timestamp("enviado_en", { withTimezone: true }),
  },
  (t) => [
    unique("correo_envio_clave_unique").on(t.tenantId, t.clave),
    unique("correo_envio_tenant_id_unique").on(t.tenantId, t.id),
    // Sin FK a membresia: el trigger correo_envio_miembro (0073) exige la membresía sin bloquear su fila (una FK tomaría FOR KEY SHARE
    // en la transacción del hecho e interbloquearía con `bloquearMiembros` FOR UPDATE del cupo de 006).
    // D-2: un solo envío de avisos pendiente y sin tomar por (estudio, usuario, tipo).
    uniqueIndex("correo_envio_pendiente_unico")
      .on(t.tenantId, t.usuarioId, t.tipo)
      .where(sql`${t.origen} = 'aviso' AND ${t.estado} = 'pendiente' AND ${t.tomadoEn} IS NULL`),
    // Tope diario (R-14) y ventana (D-2): envíos de avisos del usuario por fecha.
    index("correo_envio_usuario_idx").on(t.tenantId, t.usuarioId, t.origen, t.creadoEn),
    // Encolado (ciclo): avisos pendientes sin tomar por vencimiento.
    index("correo_envio_vencidos_idx")
      .on(t.tenantId, t.programadoPara)
      .where(sql`${t.origen} = 'aviso' AND ${t.estado} = 'pendiente' AND ${t.tomadoEn} IS NULL`),
    index("correo_envio_purga_idx").on(t.tenantId, t.creadoEn),
    check("correo_envio_origen_valido", sql`${t.origen} IN (${lista(ORIGENES_ENVIO_BD)})`),
    check("correo_envio_tipo_valido", sql`${t.tipo} IN (${lista(TIPOS_CORREO_BD)})`),
    check("correo_envio_tipo_origen", sql`(${t.origen} = 'resumen') = (${t.tipo} = 'resumen')`),
    check("correo_envio_estado_valido", sql`${t.estado} IN (${lista(ESTADOS_ENVIO_BD)})`),
    check(
      "correo_envio_motivo_valido",
      sql`(${t.estado} IN ('pendiente', 'enviado') AND ${t.motivo} IS NULL) OR (${t.estado} = 'omitido' AND ${t.motivo} IN (${lista(MOTIVOS_OMITIDO_BD)})) OR (${t.estado} = 'fallido' AND ${t.motivo} = 'transporte')`,
    ),
    check("correo_envio_clave_largo", sql`char_length(${t.clave}) BETWEEN 1 AND 200`),
    check("correo_envio_intentos_no_negativos", sql`${t.intentos} >= 0`),
    check("correo_envio_total_no_negativo", sql`${t.totalAvisos} >= 0`),
  ],
);

// 0073. Una notificación de 017 que va por correo: unida a su envío o diferida por el tope (R-14). Sigue a su notificación (cascada).
export const correoEnvioAviso = pgTable(
  "correo_envio_aviso",
  {
    tenantId: tenantId(),
    notificacionId: uuid("notificacion_id").notNull(),
    usuarioId: uuid("usuario_id").notNull(),
    tipo: text("tipo").notNull(),
    envioId: uuid("envio_id"),
    diferidoEn: timestamp("diferido_en", { withTimezone: true }),
    creadoEn: timestamp("creado_en", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
    // Lista blanca de la notificación (ids, códigos y números; nunca texto), copiada al registrarla: el worker no lee `notificacion`
    // (017: sin grants) y arma el correo con esto, la razón social del cliente y la fecha del mensaje (R-6).
    clienteId: uuid("cliente_id"),
    mensajeId: uuid("mensaje_id"),
    categoria: text("categoria"),
    recurso: text("recurso"),
    umbral: smallint("umbral"),
    notificadaEn: timestamp("notificada_en", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({ name: "correo_envio_aviso_pk", columns: [t.tenantId, t.notificacionId] }),
    foreignKey({
      name: "correo_envio_aviso_notificacion_fk",
      columns: [t.tenantId, t.notificacionId],
      foreignColumns: [notificacion.tenantId, notificacion.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "correo_envio_aviso_envio_fk",
      columns: [t.tenantId, t.envioId],
      foreignColumns: [correoEnvio.tenantId, correoEnvio.id],
    }).onDelete("cascade"),
    index("correo_envio_aviso_envio_idx").on(t.tenantId, t.envioId),
    index("correo_envio_aviso_diferido_idx")
      .on(t.tenantId, t.usuarioId, t.tipo)
      .where(sql`${t.envioId} IS NULL`),
    index("correo_envio_aviso_purga_idx").on(t.tenantId, t.creadoEn),
    check("correo_envio_aviso_tipo_valido", sql`${t.tipo} IN (${lista(TIPOS_AVISO_CORREO_BD)})`),
    check("correo_envio_aviso_envio_o_diferido", sql`${t.envioId} IS NOT NULL OR ${t.diferidoEn} IS NOT NULL`),
    check("correo_envio_aviso_categoria_formato", sql`${t.categoria} IS NULL OR ${t.categoria} ~ '^[a-z_]{1,40}$'`),
    check("correo_envio_aviso_recurso_valido", sql`${t.recurso} IS NULL OR ${t.recurso} IN ('rucs', 'usuarios')`),
    check("correo_envio_aviso_umbral_valido", sql`${t.umbral} IS NULL OR ${t.umbral} IN (90, 100)`),
  ],
);

// 0073. Token de baja de un correo (R-7): solo el SHA-256 del token; ligado a (estudio, usuario, tipo) por su envío. Sin grants para la app.
export const correoBajaToken = pgTable(
  "correo_baja_token",
  {
    tenantId: tenantId(),
    hash: bytea("hash").primaryKey(),
    usuarioId: uuid("usuario_id").notNull(),
    tipo: text("tipo").notNull(),
    envioId: uuid("envio_id").notNull(),
    creadoEn: timestamp("creado_en", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
    venceEn: timestamp("vence_en", { withTimezone: true }).notNull(),
    // 0075 (H-028-1-5): un solo uso; también lo anula cambiar ese tipo en la app después de emitido.
    anuladoEn: timestamp("anulado_en", { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: "correo_baja_token_envio_fk",
      columns: [t.tenantId, t.envioId],
      foreignColumns: [correoEnvio.tenantId, correoEnvio.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "correo_baja_token_membresia_fk",
      columns: [t.tenantId, t.usuarioId],
      foreignColumns: [membresia.tenantId, membresia.usuarioId],
    }).onDelete("cascade"),
    index("correo_baja_token_envio_idx").on(t.tenantId, t.envioId),
    index("correo_baja_token_purga_idx").on(t.tenantId, t.creadoEn),
    check("correo_baja_token_hash_32", sql`octet_length(${t.hash}) = 32`),
    check("correo_baja_token_tipo_valido", sql`${t.tipo} IN (${lista(TIPOS_CORREO_BD)})`),
  ],
);

// 0073. Fila única del ciclo de correo (patrón de `buzon_programacion`): hora y días del resumen (U-6), ventana y tope (U-9), lote del
// encolado, candado del ciclo y el último día de Lima cuyo resumen quedó creado para todos los estudios. Sin privilegios para la app.
export const correoProgramacion = pgTable(
  "correo_programacion",
  {
    id: smallint("id").primaryKey().default(1),
    horaResumen: time("hora_resumen").notNull().default("07:00"),
    diasResumen: smallint("dias_resumen").array().notNull().default(sql`'{1,2,3,4,5}'::smallint[]`),
    ventanaMin: integer("ventana_min").notNull().default(10),
    topeDiario: integer("tope_diario").notNull().default(30),
    lote: integer("lote").notNull().default(1000),
    cicloDueno: text("ciclo_dueno"),
    cicloHasta: timestamp("ciclo_hasta", { withTimezone: true }),
    ultimoCicloInicio: timestamp("ultimo_ciclo_inicio", { withTimezone: true }),
    ultimoCicloFin: timestamp("ultimo_ciclo_fin", { withTimezone: true }),
    resumenCerrado: date("resumen_cerrado"),
  },
  (t) => [
    check("correo_programacion_fila_unica", sql`${t.id} = 1`),
    check(
      "correo_programacion_dias",
      sql`cardinality(${t.diasResumen}) BETWEEN 1 AND 7 AND ${t.diasResumen} <@ '{1,2,3,4,5,6,7}'::smallint[] AND array_position(${t.diasResumen}, NULL) IS NULL`,
    ),
    check("correo_programacion_ventana", sql`${t.ventanaMin} BETWEEN 1 AND 60`),
    check("correo_programacion_tope", sql`${t.topeDiario} BETWEEN 1 AND 500`),
    check("correo_programacion_lote", sql`${t.lote} BETWEEN 1 AND 100000`),
    check("correo_programacion_dueno_largo", sql`char_length(${t.cicloDueno}) BETWEEN 1 AND 200`),
  ],
);

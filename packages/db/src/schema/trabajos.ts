import { sql } from "drizzle-orm";
import {
  char,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { cliente } from "./clientes";
import { membresia } from "./acceso";
import { id, tenantIdPorDefecto } from "./comun";
import { tenant } from "./plataforma";

// bytea <-> Buffer (pg ya devuelve Buffer para bytea; sin conversión adicional).
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

// Spec 008 (D1, D2, D8): registro de trabajos, fuente de verdad de la cola. RLS, política de borrado del worker y
// grants por columna en 0018_trabajos_rls. Va aparte del índice del esquema (el inventario de 002 fija sus tablas).
export const jobRegistro = pgTable(
  "job_registro",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .default(tenantIdPorDefecto)
      .references(() => tenant.id),
    clienteId: uuid("cliente_id").notNull(),
    ruc: char("ruc", { length: 11 }).notNull(),
    tipo: text("tipo").notNull(),
    cola: text("cola").notNull(),
    canal: text("canal").notNull(),
    prioridad: text("prioridad").notNull(),
    estado: text("estado").notNull().default("en_cola"),
    parametros: jsonb("parametros").notNull(),
    claveDedupe: bytea("clave_dedupe").notNull(),
    creadoPor: uuid("creado_por"),
    intentos: smallint("intentos").notNull().default(0),
    maxIntentos: smallint("max_intentos").notNull(),
    motivo: text("motivo"),
    resultado: jsonb("resultado"),
    disponibleDesde: timestamp("disponible_desde", { withTimezone: true })
      .notNull()
      .defaultNow(),
    creadoEn: timestamp("creado_en", { withTimezone: true })
      .notNull()
      .defaultNow(),
    iniciadoEn: timestamp("iniciado_en", { withTimezone: true }),
    terminadoEn: timestamp("terminado_en", { withTimezone: true }),
    actualizadoEn: timestamp("actualizado_en", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "job_registro_cliente_fk",
      columns: [t.tenantId, t.clienteId],
      foreignColumns: [cliente.tenantId, cliente.id],
    }),
    foreignKey({
      name: "job_registro_creado_por_fk",
      columns: [t.tenantId, t.creadoPor],
      foreignColumns: [membresia.tenantId, membresia.usuarioId],
    }),
    // D8: un solo trabajo vivo por clave en el estudio; al terminar, la clave se libera.
    uniqueIndex("job_registro_dedupe_vivo")
      .on(t.tenantId, t.claveDedupe)
      .where(sql`${t.estado} IN ('en_cola', 'ejecutando')`),
    index("job_registro_despacho_idx").on(
      t.tenantId,
      t.cola,
      t.estado,
      t.prioridad,
      t.creadoEn,
    ),
    index("job_registro_cliente_idx").on(
      t.tenantId,
      t.clienteId,
      t.creadoEn.desc().nullsFirst(),
    ),
    check(
      "job_registro_tipo_formato",
      sql`${t.tipo} ~ '^[a-z]+(\\.[a-z_]+)+$'`,
    ),
    check(
      "job_registro_cola_valida",
      sql`${t.cola} IN ('sire', 'sol', 'xml', 'archivos', 'programados', 'notificaciones')`,
    ),
    check(
      "job_registro_canal_valido",
      sql`${t.canal} IN ('sire', 'sol', 'ninguno')`,
    ),
    check(
      "job_registro_prioridad_valida",
      sql`${t.prioridad} IN ('interactivo', 'programado')`,
    ),
    check(
      "job_registro_estado_valido",
      sql`${t.estado} IN ('en_cola', 'ejecutando', 'completado', 'error', 'cancelado')`,
    ),
    check(
      "job_registro_motivo_valido",
      sql`${t.motivo} IS NULL OR ${t.motivo} IN ('sunat_no_responde', 'credencial_invalida', 'datos_invalidos', 'portal_cambio', 'interrumpido', 'acceso_retirado', 'cancelado_usuario', 'error_interno')`,
    ),
    check("job_registro_ruc_11_digitos", sql`${t.ruc} ~ '^[0-9]{11}$'`),
    check(
      "job_registro_parametros_tamano",
      sql`octet_length(${t.parametros}::text) <= 4096`,
    ),
    check(
      "job_registro_resultado_tamano",
      sql`${t.resultado} IS NULL OR octet_length(${t.resultado}::text) <= 4096`,
    ),
    check(
      "job_registro_clave_dedupe_32",
      sql`octet_length(${t.claveDedupe}) = 32`,
    ),
    check("job_registro_intentos_no_negativos", sql`${t.intentos} >= 0`),
    check("job_registro_max_intentos_positivo", sql`${t.maxIntentos} >= 1`),
  ],
);

// Spec 008 (D12, D19): límites por cola. Tabla de plataforma (sin tenant_id): la leen backend y worker, solo
// contapp_migrator escribe (0018). Con otros estudios esperando, uno no pasa de la mitad de los cupos (D19).
export const configSistema = pgTable(
  "config_sistema",
  {
    cola: text("cola").primaryKey(),
    concurrenciaGlobal: smallint("concurrencia_global").notNull(),
    concurrenciaTenant: smallint("concurrencia_tenant").notNull(),
    esperaRucMs: integer("espera_ruc_ms").notNull(),
    reintentos: smallint("reintentos").notNull(),
    backoffBaseMs: integer("backoff_base_ms").notNull(),
    maxPendientesTenant: integer("max_pendientes_tenant").notNull(),
    actualizadoEn: timestamp("actualizado_en", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "config_sistema_cola_valida",
      sql`${t.cola} IN ('sire', 'sol', 'xml', 'archivos', 'programados', 'notificaciones')`,
    ),
    check(
      "config_sistema_concurrencia_global",
      sql`${t.concurrenciaGlobal} BETWEEN 1 AND 64`,
    ),
    check(
      "config_sistema_concurrencia_tenant",
      sql`${t.concurrenciaTenant} >= 1 AND ${t.concurrenciaTenant} <= greatest(1, ${t.concurrenciaGlobal} / 2)`,
    ),
    check(
      "config_sistema_espera_ruc",
      sql`${t.esperaRucMs} BETWEEN 0 AND 600000`,
    ),
    check("config_sistema_reintentos", sql`${t.reintentos} BETWEEN 0 AND 10`),
    check(
      "config_sistema_backoff_base",
      sql`${t.backoffBaseMs} BETWEEN 100 AND 600000`,
    ),
    check(
      "config_sistema_max_pendientes",
      sql`${t.maxPendientesTenant} BETWEEN 1 AND 100000`,
    ),
  ],
);

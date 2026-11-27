import { sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { cliente } from "./clientes";
import { id, marcasDeTiempo, tenantIdPorDefecto } from "./comun";
import { tenant, usuario } from "./plataforma";

// bytea <-> Buffer (pg ya devuelve Buffer para bytea; sin conversión adicional).
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

// Spec 030 (T13, 0085): clases de regex de `nombre_clave` (escapes \uXXXX y \UXXXXXXXX del motor de regex de Postgres).
// Invisibles y de formato que se ignoran: Cc, Cf (incluye bidi y ZW*), Default_Ignorable (rellenos Hangul, selectores de variación, etiquetas).
const INVISIBLES_NOMBRE =
  "[\\u0001-\\u001f\\u007f-\\u009f\\u00ad\\u034f\\u061c\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180f\\u200b-\\u200f\\u202a-\\u202e" +
  "\\u2060-\\u206f\\u3164\\ufe00-\\ufe0f\\ufeff\\uffa0\\ufff0-\\ufffb\\u0600-\\u0605\\u06dd\\u070f\\u0890\\u0891\\u08e2" +
  "\\U000110bd\\U000110cd\\U00013430-\\U0001343f\\U0001bca0-\\U0001bca3\\U0001d173-\\U0001d17a\\U000e0000-\\U000e0fff]";
// Espacios (el ASCII y los Zs, Zl y Zp): toda racha queda como un espacio ASCII.
const ESPACIOS_NOMBRE = "[ \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]+";

// Spec 030 (D1): roles propios del estudio. Los de sistema siguen en código (005 D21). RLS FORCE y escritura solo por las
// funciones `acceso.rol_guardar` / `acceso.rol_eliminar` (0082). `nombre_clave`: el nombre sin espacios al borde, sin tildes y en
// minúsculas (único por estudio y distinto de los de sistema). Desde 0085 (T13) también sin caracteres invisibles ni de formato
// (Cc, Cf, selectores de variación, bidi) y con todo espacio Unicode (Zs, Zl, Zp) como un solo espacio ASCII; nunca vacío.
export const rol = pgTable(
  "rol",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .default(tenantIdPorDefecto)
      .references(() => tenant.id),
    id: id(),
    nombre: text("nombre").notNull(),
    nombreClave: text("nombre_clave")
      .notNull()
      .generatedAlwaysAs(
        sql`lower(regexp_replace(normalize(btrim(regexp_replace(regexp_replace(nombre, '${sql.raw(INVISIBLES_NOMBRE)}', '', 'g'), '${sql.raw(ESPACIOS_NOMBRE)}', ' ', 'g')), NFD), '[\\u0300-\\u036f]', '', 'g'))`,
      ),
    alcance: text("alcance").notNull(),
    creadoEn: timestamp("creado_en", { withTimezone: true })
      .notNull()
      .defaultNow(),
    actualizadoEn: timestamp("actualizado_en", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("rol_tenant_nombre_clave_unique").on(t.tenantId, t.nombreClave),
    unique("rol_tenant_id_unique").on(t.tenantId, t.id),
    check("rol_alcance_valido", sql`${t.alcance} IN ('global', 'asignado')`),
    check(
      "rol_nombre_valido",
      sql`char_length(${t.nombre}) BETWEEN 1 AND 40 AND btrim(${t.nombre}) <> '' AND ${t.nombre} !~ '[[:cntrl:]]'`,
    ),
    check(
      "rol_nombre_clave_no_sistema",
      sql`${t.nombreClave} NOT IN ('dueno', 'administrador', 'admin', 'contador', 'asistente', 'lectura', 'solo lectura')`,
    ),
    check("rol_nombre_clave_no_vacia", sql`${t.nombreClave} <> ''`),
  ],
);

// Spec 030 (D1): permisos de un rol propio; el catálogo de 01 §4 sin `plan.gestionar` (CA-2).
export const rolPermiso = pgTable(
  "rol_permiso",
  {
    tenantId: uuid("tenant_id").notNull().default(tenantIdPorDefecto),
    rolId: uuid("rol_id").notNull(),
    permiso: text("permiso").notNull(),
  },
  (t) => [
    primaryKey({ name: "rol_permiso_pk", columns: [t.rolId, t.permiso] }),
    index("rol_permiso_tenant_rol_idx").on(t.tenantId, t.rolId),
    foreignKey({
      name: "rol_permiso_rol_fk",
      columns: [t.tenantId, t.rolId],
      foreignColumns: [rol.tenantId, rol.id],
    }).onDelete("cascade"),
    check(
      "rol_permiso_catalogo",
      sql`${t.permiso} IN ('estudio.configurar', 'usuarios.ver', 'usuarios.gestionar', 'roles.gestionar', 'clientes.ver', 'clientes.crear', 'clientes.editar', 'clientes.archivar', 'clientes.asignar', 'credenciales.editar', 'sire.descargar', 'sire.clasificar', 'sire.aprobar_generar', 'ajustes.crear', 'ajustes.generar', 'buzon.ver', 'buzon.marcar_leido', 'buzon.atender', 'reglas.ver', 'reglas.gestionar', 'prorrata.ver', 'prorrata.gestionar', 'auditoria.ver')`,
    ),
  ],
);

// Tabla de negocio con RLS (políticas en 0002_rls_y_grants). Spec 005: desactivada_en (D9) y CHECK de rol
// (D21); el trigger membresia_ultimo_dueno (0012) impide dejar un estudio sin Dueño activo (D10). Spec 030 (D2): `rol_id` (rol
// propio, FK compuesta RESTRICT) si y solo si `rol = 'propio'`.
export const membresia = pgTable(
  "membresia",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .default(tenantIdPorDefecto)
      .references(() => tenant.id),
    usuarioId: uuid("usuario_id")
      .notNull()
      .references(() => usuario.id),
    rol: text("rol").notNull(),
    rolId: uuid("rol_id"),
    desactivadaEn: timestamp("desactivada_en", { withTimezone: true }),
    ...marcasDeTiempo(),
  },
  (t) => [
    unique("membresia_tenant_usuario_unique").on(t.tenantId, t.usuarioId),
    check(
      "membresia_rol_valido",
      sql`${t.rol} IN ('dueno', 'admin', 'contador', 'asistente', 'lectura', 'propio')`,
    ),
    check(
      "membresia_rol_propio_coherente",
      sql`(${t.rol} = 'propio') = (${t.rolId} IS NOT NULL)`,
    ),
    index("membresia_tenant_rol_idx").on(t.tenantId, t.rolId),
    foreignKey({
      name: "membresia_rol_fk",
      columns: [t.tenantId, t.rolId],
      foreignColumns: [rol.tenantId, rol.id],
    }).onDelete("restrict"),
  ],
);

// Spec 005 (D6): asignación de un miembro a un cliente. RLS y grants en 0012_acceso_rls.
export const asignacion = pgTable(
  "asignacion",
  {
    id: id(),
    tenantId: uuid("tenant_id").notNull().default(tenantIdPorDefecto),
    clienteId: uuid("cliente_id").notNull(),
    usuarioId: uuid("usuario_id").notNull(),
    tipo: text("tipo").notNull(),
    ...marcasDeTiempo(),
  },
  (t) => [
    unique("asignacion_tenant_cliente_usuario_unique").on(
      t.tenantId,
      t.clienteId,
      t.usuarioId,
    ),
    // Un solo responsable por cliente (CA-7).
    uniqueIndex("asignacion_responsable_unico")
      .on(t.tenantId, t.clienteId)
      .where(sql`${t.tipo} = 'responsable'`),
    // Filtro de alcance (D5): asignaciones de un usuario.
    index("asignacion_tenant_usuario_idx").on(t.tenantId, t.usuarioId),
    check(
      "asignacion_tipo_valido",
      sql`${t.tipo} IN ('responsable', 'colaborador')`,
    ),
    foreignKey({
      name: "asignacion_cliente_fk",
      columns: [t.tenantId, t.clienteId],
      foreignColumns: [cliente.tenantId, cliente.id],
    }),
    foreignKey({
      name: "asignacion_membresia_fk",
      columns: [t.tenantId, t.usuarioId],
      foreignColumns: [membresia.tenantId, membresia.usuarioId],
    }),
  ],
);

// Spec 005 (D7): invitación a un estudio. Solo el SHA-256 del token (32 B); RLS y grants en 0012/0013.
export const invitacion = pgTable(
  "invitacion",
  {
    id: id(),
    tenantId: uuid("tenant_id").notNull().default(tenantIdPorDefecto),
    correo: text("correo").notNull(),
    rol: text("rol").notNull(),
    // Spec 030 (D2): rol propio, como en membresia.
    rolId: uuid("rol_id"),
    invitadoPor: uuid("invitado_por").notNull(),
    // Única sin tenant_id: la aceptación busca por hash sin conocer el estudio (256 bits aleatorios).
    tokenHash: bytea("token_hash")
      .notNull()
      .unique("invitacion_token_hash_unique"),
    creadaEn: timestamp("creada_en", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Spec 030 (T6): 72 h por defecto (D7), como lo fija el repositorio; así un alta directa también vence.
    venceEn: timestamp("vence_en", { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '72 hours'`),
    aceptadaEn: timestamp("aceptada_en", { withTimezone: true }),
    aceptadaPor: uuid("aceptada_por").references(() => usuario.id),
    revocadaEn: timestamp("revocada_en", { withTimezone: true }),
  },
  (t) => [
    check(
      "invitacion_rol_valido",
      sql`${t.rol} IN ('dueno', 'admin', 'contador', 'asistente', 'lectura', 'propio')`,
    ),
    check(
      "invitacion_rol_propio_coherente",
      sql`(${t.rol} = 'propio') = (${t.rolId} IS NOT NULL)`,
    ),
    // El mismo CHECK que usuario.email (0007/0008): btrim, minúsculas, NFC y solo ASCII.
    check(
      "invitacion_correo_normalizado",
      sql`${t.correo} = btrim(${t.correo}) AND ${t.correo} = lower(${t.correo}) AND ${t.correo} IS NFC NORMALIZED AND octet_length(${t.correo}) = char_length(${t.correo})`,
    ),
    // T15 (H-005-1b-2, migración 0015): sin caracteres de control (el CHECK de arriba solo exige ASCII).
    check("invitacion_correo_sin_control", sql`${t.correo} !~ '[[:cntrl:]]'`),
    check("invitacion_token_hash_32", sql`octet_length(${t.tokenHash}) = 32`),
    // Una invitación pendiente por correo y estudio.
    uniqueIndex("invitacion_pendiente_correo_unique")
      .on(t.tenantId, t.correo)
      .where(sql`${t.aceptadaEn} IS NULL AND ${t.revocadaEn} IS NULL`),
    foreignKey({
      name: "invitacion_invitado_por_fk",
      columns: [t.tenantId, t.invitadoPor],
      foreignColumns: [membresia.tenantId, membresia.usuarioId],
    }),
    index("invitacion_tenant_rol_idx").on(t.tenantId, t.rolId),
    foreignKey({
      name: "invitacion_rol_fk",
      columns: [t.tenantId, t.rolId],
      foreignColumns: [rol.tenantId, rol.id],
    }).onDelete("restrict"),
  ],
);

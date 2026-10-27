import { sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  index,
  pgTable,
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

// Tabla de negocio con RLS (políticas en 0002_rls_y_grants). Spec 005: desactivada_en (D9) y CHECK de rol
// (D21); el trigger membresia_ultimo_dueno (0012) impide dejar un estudio sin Dueño activo (D10).
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
    desactivadaEn: timestamp("desactivada_en", { withTimezone: true }),
    ...marcasDeTiempo(),
  },
  (t) => [
    unique("membresia_tenant_usuario_unique").on(t.tenantId, t.usuarioId),
    check(
      "membresia_rol_valido",
      sql`${t.rol} IN ('dueno', 'admin', 'contador', 'asistente', 'lectura')`,
    ),
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
    invitadoPor: uuid("invitado_por").notNull(),
    // Única sin tenant_id: la aceptación busca por hash sin conocer el estudio (256 bits aleatorios).
    tokenHash: bytea("token_hash")
      .notNull()
      .unique("invitacion_token_hash_unique"),
    creadaEn: timestamp("creada_en", { withTimezone: true })
      .notNull()
      .defaultNow(),
    venceEn: timestamp("vence_en", { withTimezone: true }).notNull(),
    aceptadaEn: timestamp("aceptada_en", { withTimezone: true }),
    aceptadaPor: uuid("aceptada_por").references(() => usuario.id),
    revocadaEn: timestamp("revocada_en", { withTimezone: true }),
  },
  (t) => [
    check(
      "invitacion_rol_valido",
      sql`${t.rol} IN ('dueno', 'admin', 'contador', 'asistente', 'lectura')`,
    ),
    // El mismo CHECK que usuario.email (0007/0008): btrim, minúsculas, NFC y solo ASCII.
    check(
      "invitacion_correo_normalizado",
      sql`${t.correo} = btrim(${t.correo}) AND ${t.correo} = lower(${t.correo}) AND ${t.correo} IS NFC NORMALIZED AND octet_length(${t.correo}) = char_length(${t.correo})`,
    ),
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
  ],
);

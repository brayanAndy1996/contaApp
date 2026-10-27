import { sql } from "drizzle-orm";
import {
  check,
  customType,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { id, marcasDeTiempo, tenantIdPorDefecto } from "./comun";
import { tenant } from "./plataforma";

// bytea <-> Buffer (pg ya devuelve Buffer para bytea; sin conversión adicional).
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

// Spec 003: sobre cifrado de una credencial (D2: cliente_id sin FK). RLS y grants por columna en 0006.
export const credencial = pgTable(
  "credencial",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .default(tenantIdPorDefecto)
      .references(() => tenant.id),
    clienteId: uuid("cliente_id").notNull(),
    tipo: text("tipo").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    nonce: bytea("nonce").notNull(),
    tag: bytea("tag").notNull(),
    dekEnvuelta: bytea("dek_envuelta").notNull(),
    kekId: text("kek_id").notNull(),
    version: smallint("version").notNull().default(1),
    ...marcasDeTiempo(),
  },
  (t) => [
    unique("credencial_tenant_cliente_tipo_unique").on(
      t.tenantId,
      t.clienteId,
      t.tipo,
    ),
    check("credencial_tipo_valido", sql`${t.tipo} IN ('sol', 'sire_api')`),
    check(
      "credencial_ciphertext_largo",
      sql`octet_length(${t.ciphertext}) BETWEEN 1 AND 1100`,
    ),
    check("credencial_nonce_12", sql`octet_length(${t.nonce}) = 12`),
    check("credencial_tag_16", sql`octet_length(${t.tag}) = 16`),
    check(
      "credencial_dek_envuelta_largo",
      sql`octet_length(${t.dekEnvuelta}) BETWEEN 1 AND 1024`,
    ),
    check(
      "credencial_kek_id_formato",
      sql`${t.kekId} ~ '^[a-z0-9][a-z0-9-]{0,62}$'`,
    ),
    check("credencial_version_1", sql`${t.version} = 1`),
  ],
);

// Spec 003 (D3): registro de cada descifrado, solo inserción (sin FK a credencial: registra también ids no encontrados).
export const auditoriaDescifrado = pgTable(
  "auditoria_descifrado",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .default(tenantIdPorDefecto)
      .references(() => tenant.id),
    credencialId: uuid("credencial_id").notNull(),
    clienteId: uuid("cliente_id"),
    tipo: text("tipo"),
    motivo: text("motivo").notNull(),
    resultado: text("resultado").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "auditoria_descifrado_tipo_valido",
      sql`${t.tipo} IS NULL OR ${t.tipo} IN ('sol', 'sire_api')`,
    ),
    check(
      "auditoria_descifrado_motivo_formato",
      sql`${t.motivo} ~ '^[A-Za-z0-9._:-]{1,120}$'`,
    ),
    check(
      "auditoria_descifrado_resultado_valido",
      sql`${t.resultado} IN ('ok', 'no_encontrada', 'integridad', 'formato', 'llave')`,
    ),
  ],
);

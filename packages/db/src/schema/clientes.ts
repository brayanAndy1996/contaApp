import { sql } from "drizzle-orm";
import { boolean, char, check, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { id, marcasDeTiempo, tenantIdPorDefecto } from "./comun";
import { tenant } from "./plataforma";

// Tabla de negocio de ejemplo (D1); 007 la amplía con su migración. RLS en 0002_rls_y_grants.
export const cliente = pgTable(
  "cliente",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .default(tenantIdPorDefecto)
      .references(() => tenant.id),
    ruc: char("ruc", { length: 11 }).notNull(),
    razonSocial: text("razon_social").notNull(),
    // 007a D1: datos del contribuyente (SUNAT, informativos) y perfil fiscal declarado por el contador.
    estadoContribuyente: text("estado_contribuyente"),
    condicionContribuyente: text("condicion_contribuyente"),
    regimen: text("regimen"),
    zona: text("zona").notNull().default("general"),
    ventasExoneradas: boolean("ventas_exoneradas").notNull().default(false),
    ventasMixtas: boolean("ventas_mixtas").notNull().default(false),
    monedaHabitual: text("moneda_habitual").notNull().default("PEN"),
    // Archivado = baja lógica: no cuenta para el cupo ni se despacha; el RUC sigue ocupado (UNIQUE).
    archivadoAt: timestamp("archivado_at", { withTimezone: true }),
    ...marcasDeTiempo(),
  },
  (t) => [
    unique("cliente_tenant_ruc_unique").on(t.tenantId, t.ruc),
    unique("cliente_tenant_id_unique").on(t.tenantId, t.id),
    check("cliente_ruc_11_digitos", sql`${t.ruc} ~ '^[0-9]{11}$'`),
    check("cliente_razon_social_largo", sql`char_length(${t.razonSocial}) between 1 and 200`),
    check(
      "cliente_estado_contribuyente_largo",
      sql`${t.estadoContribuyente} is null or char_length(${t.estadoContribuyente}) between 1 and 50`,
    ),
    check(
      "cliente_condicion_contribuyente_largo",
      sql`${t.condicionContribuyente} is null or char_length(${t.condicionContribuyente}) between 1 and 50`,
    ),
    check("cliente_regimen_valido", sql`${t.regimen} is null or ${t.regimen} in ('rg','rmt','rer','nrus')`),
    check("cliente_zona_valida", sql`${t.zona} in ('general','amazonia')`),
    check("cliente_moneda_habitual_valida", sql`${t.monedaHabitual} in ('PEN','USD')`),
    index("cliente_tenant_activos_idx").on(t.tenantId).where(sql`${t.archivadoAt} is null`),
  ],
);

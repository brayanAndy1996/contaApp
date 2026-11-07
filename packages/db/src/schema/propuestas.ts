import { sql } from "drizzle-orm";
import {
  char,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { membresia } from "./acceso";
import { cliente } from "./clientes";
import { id, tenantIdPorDefecto } from "./comun";
import { tenant } from "./plataforma";

// Spec 013 (D1, D4, D15). Encabezado inmutable de cada descarga o importación de un libro (común a ventas y compras).
// RLS ENABLE + FORCE, tenant_isolation y grants (solo SELECT/INSERT) están en 0028_propuesta. Va aparte del índice del
// esquema (el inventario de 002 fija las tablas base). `trabajo_id` no tiene FK: el worker purga los trabajos terminados
// (0018) y el encabezado es inmutable, así que la referencia es informativa.
export const propuesta = pgTable(
  "propuesta",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .default(tenantIdPorDefecto)
      .references(() => tenant.id),
    clienteId: uuid("cliente_id").notNull(),
    periodo: char("periodo", { length: 6 }).notNull(),
    libro: text("libro").notNull(),
    fuente: text("fuente").notNull(),
    hash: char("hash", { length: 64 }).notNull(),
    filasRecibidas: integer("filas_recibidas").notNull(),
    filasNuevas: integer("filas_nuevas").notNull(),
    filasIguales: integer("filas_iguales").notNull(),
    filasDistintas: integer("filas_distintas").notNull(),
    usuarioId: uuid("usuario_id").notNull(),
    trabajoId: uuid("trabajo_id"),
    creadaEn: timestamp("creada_en", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Para las FK compuestas de `propuesta_diferencia`, `venta` y (014) `compra`.
    unique("propuesta_tenant_id_unique").on(t.tenantId, t.id),
    foreignKey({
      name: "propuesta_cliente_fk",
      columns: [t.tenantId, t.clienteId],
      foreignColumns: [cliente.tenantId, cliente.id],
    }),
    foreignKey({
      name: "propuesta_usuario_fk",
      columns: [t.tenantId, t.usuarioId],
      foreignColumns: [membresia.tenantId, membresia.usuarioId],
    }),
    index("propuesta_lectura_idx").on(t.clienteId, t.periodo, t.libro, t.creadaEn),
    check("propuesta_periodo_formato", sql`${t.periodo} ~ '^[0-9]{4}(0[1-9]|1[0-2])$'`),
    check("propuesta_libro_valido", sql`${t.libro} IN ('compras', 'ventas')`),
    check("propuesta_fuente_valida", sql`${t.fuente} IN ('api', 'importacion')`),
    check("propuesta_hash_formato", sql`${t.hash} ~ '^[0-9a-f]{64}$'`),
    // D16: recibidas = nuevas + iguales + distintas; D10: una propuesta admite hasta 20.000 filas.
    check(
      "propuesta_contadores_cuadran",
      sql`${t.filasNuevas} >= 0 AND ${t.filasIguales} >= 0 AND ${t.filasDistintas} >= 0 AND ${t.filasRecibidas} = ${t.filasNuevas} + ${t.filasIguales} + ${t.filasDistintas}`,
    ),
    check("propuesta_recibidas_tope", sql`${t.filasRecibidas} <= 20000`),
  ],
);

// Spec 013 (D1, D16): lo que el SIRE trajo distinto de lo ya guardado. Inmutable (grants SELECT/INSERT en 0029).
// Sin única (propuesta_id, clave): con D18 una misma clave puede tener dos diferencias en una propuesta (frente a la fila
// existente y frente a la primera aparición en la misma descarga); el índice es de lectura y se lista por (clave, id).
export const propuestaDiferencia = pgTable(
  "propuesta_diferencia",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .default(tenantIdPorDefecto)
      .references(() => tenant.id),
    propuestaId: uuid("propuesta_id").notNull(),
    clave: text("clave").notNull(),
    tipo: text("tipo").notNull(),
    serie: text("serie").notNull(),
    numero: text("numero").notNull(),
    origenExistente: text("origen_existente").notNull(),
    campos: text("campos").array().notNull(),
    valoresSire: jsonb("valores_sire").notNull(),
  },
  (t) => [
    foreignKey({
      name: "propuesta_diferencia_propuesta_fk",
      columns: [t.tenantId, t.propuestaId],
      foreignColumns: [propuesta.tenantId, propuesta.id],
    }),
    index("propuesta_diferencia_propuesta_idx").on(t.tenantId, t.propuestaId, t.clave),
    check("propuesta_diferencia_origen_valido", sql`${t.origenExistente} IN ('sire', 'manual')`),
    check("propuesta_diferencia_campos_no_vacio", sql`cardinality(${t.campos}) >= 1`),
    check("propuesta_diferencia_valores_objeto", sql`jsonb_typeof(${t.valoresSire}) = 'object'`),
  ],
);

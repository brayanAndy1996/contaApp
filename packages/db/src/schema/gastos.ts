import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  char,
  check,
  foreignKey,
  integer,
  jsonb,
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
import { compra } from "./compras";
import { tenant, usuario } from "./plataforma";

// Spec 027 (D-2 a D-4; R-6, R-7, R-11 a R-14). Gastos no deducibles: diccionario global de la plataforma con su historial, palabras
// propias del estudio, globales desactivadas por el estudio, umbral, categorías permitidas o quitadas por cliente y caché de CIIU.
// Nadie de la app escribe directo: las del estudio las escriben las funciones acotadas de 0070 (SECURITY DEFINER de
// contapp_migrator) y las de plataforma las `auth.gnd_global_*` (dueño contapp_auth). RLS ENABLE + FORCE, tenant_isolation y grants
// en 0069 (backend y worker SELECT). Las dos de plataforma no tienen tenant_id ni RLS (como `plan`). Va aparte del índice del
// esquema, como 014–026. Ninguna columna termina en `_at` (013: `_en`).

/** Las seis categorías cerradas de 011 (`CATEGORIAS_GND` del dominio). */
export const CATEGORIAS_GND_BD = [
  "calzado-ropa",
  "juguetes",
  "entretenimiento",
  "alimentos-personales",
  "cuidado-personal",
  "utiles-escolares",
] as const;
export const ORIGENES_PALABRA_BD = ["manual", "aprendida"] as const;
export const ACCIONES_HISTORIAL_GLOBAL_BD = ["agregada", "editada"] as const;

const lista = (valores: readonly string[]) => sql.raw(valores.map((v) => `'${v}'`).join(", "));
const arreglo = (valores: readonly string[]) => sql.raw(`ARRAY[${valores.map((v) => `'${v}'`).join(", ")}]::text[]`);
/** Palabra normalizada: una sola, de 3 a 40 letras y dígitos sin tildes ni mayúsculas. */
const PALABRA = sql.raw(`'^[a-z0-9]{3,40}$'`);
/** Excepciones unidas por `|`: frases de 1 a 3 palabras normalizadas (un nulo deja `||` o un `|` al borde y no pasa). */
const FRASES = sql.raw(`'^[a-z0-9]+( [a-z0-9]+){0,2}(\\|[a-z0-9]+( [a-z0-9]+){0,2})*$'`);

const tenantId = () =>
  uuid("tenant_id")
    .notNull()
    .default(tenantIdPorDefecto)
    .references(() => tenant.id);

const excepcionesValidas = (e: AnyPgColumn) =>
  sql`cardinality(${e}) <= 5 AND (cardinality(${e}) = 0 OR (array_ndims(${e}) = 1 AND array_to_string(${e}, '|', '') ~ ${FRASES}))`;

// 0069. Diccionario global (plataforma). Lo edita solo el super-admin por `auth.gnd_global_*`.
export const gndPalabraGlobal = pgTable(
  "gnd_palabra_global",
  {
    id: id(),
    palabra: text("palabra").notNull(),
    categoria: text("categoria").notNull(),
    excepciones: text("excepciones").array().notNull().default(sql`'{}'::text[]`),
    activa: boolean("activa").notNull().default(true),
    version: integer("version").notNull().default(1),
    actualizadaEn: timestamp("actualizada_en", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  },
  (t) => [
    unique("gnd_palabra_global_palabra_unique").on(t.palabra),
    check("gnd_palabra_global_palabra_valida", sql`${t.palabra} ~ ${PALABRA}`),
    check("gnd_palabra_global_categoria_valida", sql`${t.categoria} IN (${lista(CATEGORIAS_GND_BD)})`),
    check("gnd_palabra_global_excepciones_validas", excepcionesValidas(t.excepciones)),
    check("gnd_palabra_global_version_positiva", sql`${t.version} >= 1`),
  ],
);

// 0069. Historial del diccionario global: solo inserción (trigger BEFORE UPDATE OR DELETE -> 42501 salvo superusuario).
export const gndGlobalHistorial = pgTable(
  "gnd_global_historial",
  {
    id: id(),
    palabraGlobalId: uuid("palabra_global_id").notNull(),
    accion: text("accion").notNull(),
    antes: jsonb("antes"),
    despues: jsonb("despues"),
    usuarioId: uuid("usuario_id")
      .notNull()
      .references(() => usuario.id),
    ocurridaEn: timestamp("ocurrida_en", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  },
  (t) => [
    foreignKey({
      name: "gnd_global_historial_global_fk",
      columns: [t.palabraGlobalId],
      foreignColumns: [gndPalabraGlobal.id],
    }),
    check("gnd_global_historial_accion_valida", sql`${t.accion} IN (${lista(ACCIONES_HISTORIAL_GLOBAL_BD)})`),
  ],
);

// 0069. Palabras propias del estudio (manuales o aprendidas al excluir una compra con XML). Única por (estudio, palabra).
export const gndPalabraEstudio = pgTable(
  "gnd_palabra_estudio",
  {
    id: id(),
    tenantId: tenantId(),
    palabra: text("palabra").notNull(),
    categoria: text("categoria").notNull(),
    excepciones: text("excepciones").array().notNull().default(sql`'{}'::text[]`),
    origen: text("origen").notNull(),
    activa: boolean("activa").notNull().default(true),
    version: integer("version").notNull().default(1),
    creadoPor: uuid("creado_por")
      .notNull()
      .references(() => usuario.id),
    compraOrigenId: uuid("compra_origen_id"),
    creadaEn: timestamp("creada_en", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
    actualizadaEn: timestamp("actualizada_en", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  },
  (t) => [
    unique("gnd_palabra_estudio_palabra_unique").on(t.tenantId, t.palabra),
    foreignKey({
      name: "gnd_palabra_estudio_compra_fk",
      columns: [t.tenantId, t.compraOrigenId],
      foreignColumns: [compra.tenantId, compra.id],
    }),
    check("gnd_palabra_estudio_palabra_valida", sql`${t.palabra} ~ ${PALABRA}`),
    check("gnd_palabra_estudio_categoria_valida", sql`${t.categoria} IN (${lista(CATEGORIAS_GND_BD)})`),
    check("gnd_palabra_estudio_excepciones_validas", excepcionesValidas(t.excepciones)),
    check("gnd_palabra_estudio_origen_valido", sql`${t.origen} IN (${lista(ORIGENES_PALABRA_BD)})`),
    check("gnd_palabra_estudio_version_positiva", sql`${t.version} >= 1`),
    check(
      "gnd_palabra_estudio_compra_segun_origen",
      sql`${t.origen} <> 'aprendida' OR ${t.compraOrigenId} IS NOT NULL`,
    ),
  ],
);

// 0069. Globales que el estudio desactivó para sí (la fila existe mientras está desactivada).
export const gndGlobalDesactivada = pgTable(
  "gnd_global_desactivada",
  {
    tenantId: tenantId(),
    palabraGlobalId: uuid("palabra_global_id").notNull(),
    usuarioId: uuid("usuario_id")
      .notNull()
      .references(() => usuario.id),
    desactivadaEn: timestamp("desactivada_en", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({ name: "gnd_global_desactivada_pk", columns: [t.tenantId, t.palabraGlobalId] }),
    foreignKey({
      name: "gnd_global_desactivada_global_fk",
      columns: [t.palabraGlobalId],
      foreignColumns: [gndPalabraGlobal.id],
    }),
  ],
);

// 0069. Umbral del estudio (sin fila: 3 y versión 0).
export const gndConfig = pgTable(
  "gnd_config",
  {
    tenantId: tenantId().primaryKey(),
    umbral: smallint("umbral").notNull(),
    version: integer("version").notNull(),
  },
  (t) => [
    check("gnd_config_umbral_rango", sql`${t.umbral} BETWEEN 1 AND 20`),
    check("gnd_config_version_positiva", sql`${t.version} >= 1`),
  ],
);

// 0069. Categorías permitidas y quitadas por cliente (sin fila: vacías y versión 0).
export const gndClienteCategorias = pgTable(
  "gnd_cliente_categorias",
  {
    tenantId: tenantId(),
    clienteId: uuid("cliente_id").notNull(),
    permitidas: text("permitidas").array().notNull().default(sql`'{}'::text[]`),
    quitadas: text("quitadas").array().notNull().default(sql`'{}'::text[]`),
    version: integer("version").notNull(),
  },
  (t) => [
    primaryKey({ name: "gnd_cliente_categorias_pk", columns: [t.tenantId, t.clienteId] }),
    foreignKey({
      name: "gnd_cliente_categorias_cliente_fk",
      columns: [t.tenantId, t.clienteId],
      foreignColumns: [cliente.tenantId, cliente.id],
    }),
    check(
      "gnd_cliente_categorias_listas_validas",
      sql`${t.permitidas} <@ ${arreglo(CATEGORIAS_GND_BD)} AND ${t.quitadas} <@ ${arreglo(CATEGORIAS_GND_BD)} AND NOT (${t.permitidas} && ${t.quitadas})`,
    ),
    check("gnd_cliente_categorias_version_positiva", sql`${t.version} >= 1`),
  ],
);

// 0069. Caché de CIIU por estudio y RUC (cliente o proveedor). `ciiu` null = «sin dato»; dura 30 días por `consultado_en`.
export const gndCiiu = pgTable(
  "gnd_ciiu",
  {
    tenantId: tenantId(),
    ruc: char("ruc", { length: 11 }).notNull(),
    ciiu: char("ciiu", { length: 4 }),
    consultadoEn: timestamp("consultado_en", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({ name: "gnd_ciiu_pk", columns: [t.tenantId, t.ruc] }),
    check("gnd_ciiu_ruc_formato", sql`${t.ruc} ~ '^[0-9]{11}$'`),
    check("gnd_ciiu_ciiu_formato", sql`${t.ciiu} IS NULL OR ${t.ciiu} ~ '^[0-9]{4}$'`),
  ],
);

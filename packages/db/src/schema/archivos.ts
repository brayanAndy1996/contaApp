import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  customType,
  foreignKey,
  integer,
  jsonb,
  numeric,
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

// bytea <-> Buffer (pg ya devuelve Buffer para bytea; sin conversión adicional).
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

// Impacto en IGV: NUMERIC(14,2), nunca doble precisión (CLAUDE.md).
const impacto = (nombre: string) => numeric(nombre, { precision: 14, scale: 2 });

// Nombre seguro del TXT y del ZIP (la gramática de `generarTxt`: hasta 100 caracteres, sin `/`, `\`, `..`, espacios ni controles).
const nombreSeguro = (extension: "txt" | "zip") =>
  `'^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\\.${extension}$'`;

// Spec 012b (D3, D5, D6): una versión generada del archivo de reemplazo de un libro. Inmutable: solo inserción y solo por el worker;
// RLS, grants y los triggers (inmutabilidad para todos; al insertar, periodo `generado` por quien genera y versión = máx + 1) están
// en 0040_archivo_generado. Va aparte del índice del esquema, como las tablas de 013, 014 y 016.
export const archivoGenerado = pgTable(
  "archivo_generado",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .default(tenantIdPorDefecto)
      .references(() => tenant.id),
    clienteId: uuid("cliente_id").notNull(),
    periodo: char("periodo", { length: 6 }).notNull(),
    libro: text("libro").notNull(),
    version: integer("version").notNull(),
    formatoId: text("formato_id").notNull(),
    formatoVersion: text("formato_version").notNull(),
    provisional: boolean("provisional").notNull(),
    nombreTxt: text("nombre_txt").notNull(),
    nombreZip: text("nombre_zip").notNull(),
    sha256Txt: bytea("sha256_txt").notNull(),
    sha256Zip: bytea("sha256_zip").notNull(),
    bytesZip: integer("bytes_zip").notNull(),
    lineas: integer("lineas").notNull(),
    // sha256 hex del texto canónico del previo (`canonHuella`).
    huella: text("huella").notNull(),
    modificadas: integer("modificadas").notNull(),
    excluidas: integer("excluidas").notNull(),
    agregadas: integer("agregadas").notNull(),
    // Por destino solo en compras (DG, DGNG, DNG); en ventas son nulos.
    impactoIgvDg: impacto("impacto_igv_dg"),
    impactoIgvDgng: impacto("impacto_igv_dgng"),
    impactoIgvDng: impacto("impacto_igv_dng"),
    impactoIgvTotal: impacto("impacto_igv_total").notNull(),
    // Conteos por código de aviso (la lista por fila se ve en el previo).
    avisos: jsonb("avisos").notNull(),
    ruta: text("ruta").notNull(),
    trabajoId: uuid("trabajo_id").notNull(),
    generadoPor: uuid("generado_por").notNull(),
    generadoEn: timestamp("generado_en", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("archivo_generado_version_unique").on(t.tenantId, t.clienteId, t.periodo, t.libro, t.version),
    unique("archivo_generado_trabajo_unique").on(t.tenantId, t.trabajoId),
    foreignKey({
      name: "archivo_generado_cliente_fk",
      columns: [t.tenantId, t.clienteId],
      foreignColumns: [cliente.tenantId, cliente.id],
    }),
    foreignKey({
      name: "archivo_generado_generado_por_fk",
      columns: [t.tenantId, t.generadoPor],
      foreignColumns: [membresia.tenantId, membresia.usuarioId],
    }),
    check("archivo_generado_libro_valido", sql`${t.libro} IN ('compras', 'ventas')`),
    check("archivo_generado_periodo_formato", sql`${t.periodo} ~ '^[0-9]{4}(0[1-9]|1[0-2])$'`),
    check("archivo_generado_version_positiva", sql`${t.version} >= 1`),
    check(
      "archivo_generado_formato_valido",
      sql`char_length(${t.formatoId}) BETWEEN 1 AND 64 AND char_length(${t.formatoVersion}) BETWEEN 1 AND 64`,
    ),
    check("archivo_generado_sha256_txt_largo", sql`octet_length(${t.sha256Txt}) = 32`),
    check("archivo_generado_sha256_zip_largo", sql`octet_length(${t.sha256Zip}) = 32`),
    check("archivo_generado_huella_formato", sql`${t.huella} ~ '^[0-9a-f]{64}$'`),
    check(
      "archivo_generado_nombre_txt_formato",
      sql`${t.nombreTxt} ~ ${sql.raw(nombreSeguro("txt"))} AND position('..' in ${t.nombreTxt}) = 0`,
    ),
    check(
      "archivo_generado_nombre_zip_formato",
      sql`${t.nombreZip} ~ ${sql.raw(nombreSeguro("zip"))} AND position('..' in ${t.nombreZip}) = 0`,
    ),
    // La ruta del storage sale de la fila (rutaArchivo de packages/storage): nadie la apunta a otro objeto.
    check(
      "archivo_generado_ruta_formato",
      sql`${t.ruta} = 'archivos/' || ${t.tenantId}::text || '/' || ${t.clienteId}::text || '/' || ${t.id}::text || '.zip'`,
    ),
    check(
      "archivo_generado_conteos_no_negativos",
      sql`${t.bytesZip} >= 0 AND ${t.lineas} >= 0 AND ${t.modificadas} >= 0 AND ${t.excluidas} >= 0 AND ${t.agregadas} >= 0`,
    ),
    // Impactos por destino nulos si y solo si el libro es ventas.
    check(
      "archivo_generado_impactos_segun_libro",
      sql`(${t.libro} = 'ventas' AND ${t.impactoIgvDg} IS NULL AND ${t.impactoIgvDgng} IS NULL AND ${t.impactoIgvDng} IS NULL) OR (${t.libro} <> 'ventas' AND ${t.impactoIgvDg} IS NOT NULL AND ${t.impactoIgvDgng} IS NOT NULL AND ${t.impactoIgvDng} IS NOT NULL)`,
    ),
    check(
      "archivo_generado_avisos_conteos",
      sql`jsonb_typeof(${t.avisos}) = 'object' AND octet_length(${t.avisos}::text) <= 2048`,
    ),
  ],
);

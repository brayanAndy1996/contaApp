// Spec 012b (T4, rojo): declaracion Drizzle de `archivo_generado` (0040), `venta_periodo` y `venta_exclusion` (0039), sin BD. Las
// restricciones reales (RLS, triggers, grants, carreras) las prueban tests/aislamiento/{archivos,ventas}-*.spec.ts. Hasta T10 falla
// porque `../schema/archivos` no existe y `../schema/ventas` no exporta las tablas nuevas. Nombres exportados: archivoGenerado
// (schema/archivos), ventaPeriodo y ventaExclusion (schema/ventas).
import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { archivoGenerado } from "../schema/archivos";
import { ventaExclusion, ventaPeriodo } from "../schema/ventas";

type Config = ReturnType<typeof getTableConfig>;
const fks = (c: Config) =>
  c.foreignKeys.map((f) => {
    const r = f.reference();
    return {
      desde: r.columns.map((x) => x.name),
      hacia: getTableName(r.foreignTable),
      destino: r.foreignColumns.map((x) => x.name),
    };
  });
const opcionales = (c: Config) =>
  c.columns
    .filter((x) => !x.notNull)
    .map((x) => x.name)
    .sort();
const col = (c: Config, n: string) => c.columns.find((x) => x.name === n)!;

describe("esquema 012b: archivo_generado", () => {
  const c = getTableConfig(archivoGenerado);

  it("se llama archivo_generado y tiene las 28 columnas del plan; solo los impactos por destino son opcionales", () => {
    expect(getTableName(archivoGenerado)).toBe("archivo_generado");
    expect(c.columns.map((x) => x.name).sort()).toEqual(
      [
        "id",
        "tenant_id",
        "cliente_id",
        "periodo",
        "libro",
        "version",
        "formato_id",
        "formato_version",
        "provisional",
        "nombre_txt",
        "nombre_zip",
        "sha256_txt",
        "sha256_zip",
        "bytes_zip",
        "lineas",
        "huella",
        "modificadas",
        "excluidas",
        "agregadas",
        "impacto_igv_dg",
        "impacto_igv_dgng",
        "impacto_igv_dng",
        "impacto_igv_total",
        "avisos",
        "ruta",
        "trabajo_id",
        "generado_por",
        "generado_en",
      ].sort(),
    );
    expect(opcionales(c)).toEqual([
      "impacto_igv_dg",
      "impacto_igv_dgng",
      "impacto_igv_dng",
    ]);
  });

  it("los impactos son numeric(14, 2) (nunca doble precision), los hashes bytea y los avisos jsonb", () => {
    for (const n of [
      "impacto_igv_dg",
      "impacto_igv_dgng",
      "impacto_igv_dng",
      "impacto_igv_total",
    ])
      expect(col(c, n).getSQLType(), n).toBe("numeric(14, 2)");
    expect(col(c, "sha256_txt").getSQLType()).toBe("bytea");
    expect(col(c, "sha256_zip").getSQLType()).toBe("bytea");
    expect(col(c, "avisos").getSQLType()).toBe("jsonb");
    expect(col(c, "periodo").getSQLType()).toBe("char(6)");
    expect(col(c, "id").getSQLType()).toBe("uuid");
  });

  it("unicas (tenant_id, cliente_id, periodo, libro, version) y (tenant_id, trabajo_id); FK compuestas a cliente y membresia", () => {
    const unicas = [
      ...c.uniqueConstraints.map((u) => u.columns.map((x) => x.name)),
      ...c.indexes
        .filter((i) => (i.config as { unique?: boolean }).unique)
        .map((i) =>
          (i.config.columns as { name: string }[]).map((x) => x.name),
        ),
    ];
    expect(unicas).toContainEqual([
      "tenant_id",
      "cliente_id",
      "periodo",
      "libro",
      "version",
    ]);
    expect(unicas).toContainEqual(["tenant_id", "trabajo_id"]);
    expect(fks(c)).toContainEqual({
      desde: ["tenant_id", "cliente_id"],
      hacia: "cliente",
      destino: ["tenant_id", "id"],
    });
    expect(fks(c)).toContainEqual({
      desde: ["tenant_id", "generado_por"],
      hacia: "membresia",
      destino: ["tenant_id", "usuario_id"],
    });
  });
});

describe("esquema 012b: venta_periodo", () => {
  const c = getTableConfig(ventaPeriodo);
  it("se llama venta_periodo, es como compra_periodo (solo marcado_por y marcado_en opcionales) y tiene su PK y su FK a cliente", () => {
    expect(getTableName(ventaPeriodo)).toBe("venta_periodo");
    expect(c.columns.map((x) => x.name).sort()).toEqual([
      "cliente_id",
      "estado",
      "marcado_en",
      "marcado_por",
      "periodo",
      "tenant_id",
    ]);
    expect(opcionales(c)).toEqual(["marcado_en", "marcado_por"]);
    expect(
      c.primaryKeys.map((p) => p.columns.map((x) => x.name)),
    ).toContainEqual(["tenant_id", "cliente_id", "periodo"]);
    expect(fks(c)).toContainEqual({
      desde: ["tenant_id", "cliente_id"],
      hacia: "cliente",
      destino: ["tenant_id", "id"],
    });
    expect(fks(c)).toContainEqual({
      desde: ["tenant_id", "marcado_por"],
      hacia: "membresia",
      destino: ["tenant_id", "usuario_id"],
    });
  });
});

describe("esquema 012b: venta_exclusion", () => {
  const c = getTableConfig(ventaExclusion);
  it("se llama venta_exclusion y tiene las 10 columnas del plan; solo restaurada_por y restaurada_en son opcionales", () => {
    expect(getTableName(ventaExclusion)).toBe("venta_exclusion");
    expect(c.columns.map((x) => x.name).sort()).toEqual(
      [
        "id",
        "tenant_id",
        "cliente_id",
        "periodo",
        "venta_id",
        "motivo",
        "excluida_por",
        "excluida_en",
        "restaurada_por",
        "restaurada_en",
      ].sort(),
    );
    expect(opcionales(c)).toEqual(["restaurada_en", "restaurada_por"]);
  });

  it("FK compuestas a cliente, a venta (tenant_id, id) y a membresia; indice unico parcial de una sola vigente por venta", () => {
    expect(fks(c)).toContainEqual({
      desde: ["tenant_id", "cliente_id"],
      hacia: "cliente",
      destino: ["tenant_id", "id"],
    });
    expect(fks(c)).toContainEqual({
      desde: ["tenant_id", "venta_id"],
      hacia: "venta",
      destino: ["tenant_id", "id"],
    });
    expect(fks(c)).toContainEqual({
      desde: ["tenant_id", "excluida_por"],
      hacia: "membresia",
      destino: ["tenant_id", "usuario_id"],
    });
    const parcial = c.indexes
      .map(
        (i) =>
          i.config as unknown as {
            unique?: boolean;
            where?: unknown;
            columns: { name: string }[];
          },
      )
      .find((i) => i.unique && i.where !== undefined);
    expect(parcial?.columns.map((x) => x.name)).toEqual([
      "tenant_id",
      "venta_id",
    ]);
  });
});

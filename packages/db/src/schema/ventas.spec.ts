import { getTableName } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { venta, ventaSaltoJustificado } from "./ventas";

// Spec 013 (T2, rojo): declaración Drizzle de `venta` (0030) y `venta_salto_justificado` (0031), sin BD. Las restricciones
// reales (RLS, trigger, grants, carreras) las prueban tests/aislamiento/venta*.spec.ts. Hasta T8 falla porque `./ventas` no
// existe. Nombres exportados: `venta` y `ventaSaltoJustificado` (patrón de credenciales.ts); columnas y restricciones, las de
// plan.md (Contratos: tablas).
const dialecto = new PgDialect();
const sqlDe = (x: unknown) => dialecto.sqlToQuery(x as never).sql;

type Config = ReturnType<typeof getTableConfig>;
const unicas = (c: Config): string[][] => [
  ...c.uniqueConstraints.map((u) => u.columns.map((x) => x.name)),
  ...c.indexes
    .filter((i) => (i.config as { unique?: boolean }).unique)
    .map((i) => (i.config.columns as { name: string }[]).map((x) => x.name)),
];
const fks = (c: Config) =>
  c.foreignKeys.map((f) => {
    const r = f.reference();
    return {
      desde: r.columns.map((x) => x.name),
      hacia: getTableName(r.foreignTable),
      destino: r.foreignColumns.map((x) => x.name),
    };
  });
const MONTOS = ["base_gravada", "igv", "exonerada", "inafecta", "isc", "icbper", "otros", "total"];

describe("esquema 013: venta", () => {
  const c = getTableConfig(venta);
  const col = (n: string) => c.columns.find((x) => x.name === n)!;

  it("se llama venta y tiene las 26 columnas del plan", () => {
    expect(getTableName(venta)).toBe("venta");
    expect(c.columns.map((x) => x.name).sort()).toEqual(
      [
        "id", "tenant_id", "cliente_id", "periodo", "propuesta_id", "origen", "clave", "tipo", "serie", "numero",
        "numero_n", "fecha", "tipo_doc_contraparte", "doc_contraparte", "moneda", "tipo_cambio", "base_gravada", "igv",
        "exonerada", "inafecta", "isc", "icbper", "otros", "total", "creada_por", "creada_en",
      ].sort(),
    );
  });

  it("solo propuesta_id, numero_n, tipo_cambio y creada_por son opcionales", () => {
    expect(
      c.columns
        .filter((x) => !x.notNull)
        .map((x) => x.name)
        .sort(),
    ).toEqual(["creada_por", "numero_n", "propuesta_id", "tipo_cambio"]);
  });

  it("los ocho montos son numeric(14, 2): nunca doble precisión ni entero", () => {
    for (const m of MONTOS) expect(col(m).getSQLType(), m).toBe("numeric(14, 2)");
  });

  it("tipos de texto del plan: periodo char(6), tipo char(2), serie varchar(4), numero varchar(20), fecha date", () => {
    expect(col("periodo").getSQLType()).toBe("char(6)");
    expect(col("tipo").getSQLType()).toBe("char(2)");
    expect(col("serie").getSQLType()).toBe("varchar(4)");
    expect(col("numero").getSQLType()).toBe("varchar(20)");
    expect(col("fecha").getSQLType()).toBe("date");
  });

  it("tipo_cambio es numeric (la escala de TipoCambio de 010) y tenant_id sale del contexto", () => {
    expect(col("tipo_cambio").getSQLType()).toMatch(/^numeric/);
    expect(sqlDe(col("tenant_id").default)).toContain("app.tenant_id");
  });

  it("FK compuestas a cliente(tenant_id, id) y a propuesta(tenant_id, id)", () => {
    const f = fks(c);
    expect(f).toContainEqual({ desde: ["tenant_id", "cliente_id"], hacia: "cliente", destino: ["tenant_id", "id"] });
    expect(f).toContainEqual({ desde: ["tenant_id", "propuesta_id"], hacia: "propuesta", destino: ["tenant_id", "id"] });
  });

  it("única (tenant_id, cliente_id, periodo, clave) sin condición", () => {
    expect(unicas(c)).toContainEqual(["tenant_id", "cliente_id", "periodo", "clave"]);
  });

  it("índice de lectura (cliente_id, periodo, tipo, serie, numero_n)", () => {
    const columnas = c.indexes.map((i) => (i.config.columns as { name: string }[]).map((x) => x.name));
    expect(columnas).toContainEqual(["cliente_id", "periodo", "tipo", "serie", "numero_n"]);
  });

  it("CHECK: origen sire|manual, moneda PEN|USD y propuesta_id nulo si y solo si origen = manual", () => {
    const todos = c.checks.map((k) => sqlDe(k.value)).join(" || ");
    expect(todos).toContain("'sire'");
    expect(todos).toContain("'manual'");
    expect(todos).toContain("'PEN'");
    expect(todos).toContain("'USD'");
    expect(todos).toContain("propuesta_id");
  });
});

describe("esquema 013: venta_salto_justificado", () => {
  const c = getTableConfig(ventaSaltoJustificado);

  it("se llama venta_salto_justificado y tiene las 13 columnas del plan; solo revertido_* son opcionales", () => {
    expect(getTableName(ventaSaltoJustificado)).toBe("venta_salto_justificado");
    expect(c.columns.map((x) => x.name).sort()).toEqual(
      [
        "id", "tenant_id", "cliente_id", "periodo", "tipo", "serie", "desde", "hasta", "comentario", "usuario_id",
        "creada_en", "revertido_por", "revertido_en",
      ].sort(),
    );
    expect(
      c.columns
        .filter((x) => !x.notNull)
        .map((x) => x.name)
        .sort(),
    ).toEqual(["revertido_en", "revertido_por"]);
  });

  it("FK compuesta (tenant_id, cliente_id) -> cliente(tenant_id, id)", () => {
    expect(fks(c)).toContainEqual({ desde: ["tenant_id", "cliente_id"], hacia: "cliente", destino: ["tenant_id", "id"] });
  });

  it("única PARCIAL (tenant_id, cliente_id, periodo, tipo, serie, desde, hasta) WHERE revertido_en IS NULL", () => {
    type Indice = { unique?: boolean; where?: unknown; columns: { name: string }[] };
    const parcial = c.indexes
      .map((i) => i.config as unknown as Indice)
      .find((i) => i.unique && i.where !== undefined);
    expect(parcial, "falta la única parcial de justificaciones vigentes").toBeDefined();
    expect(parcial!.columns.map((x) => x.name)).toEqual([
      "tenant_id", "cliente_id", "periodo", "tipo", "serie", "desde", "hasta",
    ]);
    expect(sqlDe(parcial!.where)).toMatch(/revertido_en.*is null/i);
  });

  it("CHECK: desde <= hasta, enteros de 1 a 8 dígitos y comentario de 1 a 500", () => {
    const todos = c.checks.map((k) => sqlDe(k.value)).join(" || ");
    expect(todos).toContain("desde");
    expect(todos).toContain("hasta");
    expect(todos).toContain("99999999");
    expect(todos).toContain("500");
  });
});

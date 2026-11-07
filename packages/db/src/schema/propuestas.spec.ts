import { getTableName } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { propuesta, propuestaDiferencia } from "./propuestas";

// Spec 013 (T2, rojo): declaración Drizzle de `propuesta` (0028) y `propuesta_diferencia` (0029), sin BD. Las restricciones
// reales (RLS, grants, CHECK ejecutados) las prueban tests/aislamiento/propuesta*.spec.ts. Hasta T8 falla porque
// `./propuestas` no existe. Los nombres exportados (`propuesta`, `propuestaDiferencia`) siguen el patrón de credenciales.ts
// y trabajos.ts (tabla en camelCase); los de columnas y restricciones son los del plan.md (Contratos: tablas).
const dialecto = new PgDialect();
const sqlDe = (x: unknown) => dialecto.sqlToQuery(x as never).sql;

const unicas = (c: ReturnType<typeof getTableConfig>): string[][] => [
  ...c.uniqueConstraints.map((u) => u.columns.map((x) => x.name)),
  ...c.indexes
    .filter((i) => (i.config as { unique?: boolean }).unique)
    .map((i) => (i.config.columns as { name: string }[]).map((x) => x.name)),
];

const fksCompuestas = (c: ReturnType<typeof getTableConfig>) =>
  c.foreignKeys.map((f) => {
    const r = f.reference();
    return {
      desde: r.columns.map((x) => x.name),
      hacia: getTableName(r.foreignTable),
      destino: r.foreignColumns.map((x) => x.name),
    };
  });

describe("esquema 013: propuesta", () => {
  const c = getTableConfig(propuesta);

  it("se llama propuesta y tiene las 14 columnas del plan; trabajo_id es la única opcional", () => {
    expect(getTableName(propuesta)).toBe("propuesta");
    expect(c.columns.map((x) => x.name).sort()).toEqual(
      [
        "id", "tenant_id", "cliente_id", "periodo", "libro", "fuente", "hash", "filas_recibidas", "filas_nuevas",
        "filas_iguales", "filas_distintas", "usuario_id", "trabajo_id", "creada_en",
      ].sort(),
    );
    expect(c.columns.filter((x) => !x.notNull).map((x) => x.name)).toEqual(["trabajo_id"]);
  });

  it("periodo char(6) y hash char(64); tenant_id NOT NULL tomado del contexto (app.tenant_id)", () => {
    const col = (n: string) => c.columns.find((x) => x.name === n)!;
    expect(col("periodo").getSQLType()).toBe("char(6)");
    expect(col("hash").getSQLType()).toBe("char(64)");
    expect(col("tenant_id").notNull).toBe(true);
    expect(sqlDe(col("tenant_id").default)).toContain("app.tenant_id");
  });

  it("única (tenant_id, id) para las FK compuestas de venta y de compra", () => {
    expect(unicas(c)).toContainEqual(["tenant_id", "id"]);
  });

  it("FK compuesta (tenant_id, cliente_id) -> cliente(tenant_id, id) y FK a tenant(id)", () => {
    const f = fksCompuestas(c);
    expect(f).toContainEqual({ desde: ["tenant_id", "cliente_id"], hacia: "cliente", destino: ["tenant_id", "id"] });
    expect(f.some((x) => x.hacia === "tenant" && x.desde[0] === "tenant_id")).toBe(true);
  });

  it("CHECK: recibidas = nuevas + iguales + distintas, recibidas <= 20000, libro y fuente acotados", () => {
    const todos = c.checks.map((k) => sqlDe(k.value)).join(" || ");
    expect(c.checks.length).toBeGreaterThanOrEqual(3);
    expect(todos).toContain("filas_recibidas");
    expect(todos).toContain("filas_nuevas");
    expect(todos).toContain("filas_iguales");
    expect(todos).toContain("filas_distintas");
    expect(todos).toContain("20000");
    expect(todos).toContain("'compras'");
    expect(todos).toContain("'ventas'");
    expect(todos).toContain("'api'");
    expect(todos).toContain("'importacion'");
  });
});

describe("esquema 013: propuesta_diferencia", () => {
  const c = getTableConfig(propuestaDiferencia);

  it("se llama propuesta_diferencia y tiene las 10 columnas del plan, todas obligatorias", () => {
    expect(getTableName(propuestaDiferencia)).toBe("propuesta_diferencia");
    expect(c.columns.map((x) => x.name).sort()).toEqual(
      [
        "id", "tenant_id", "propuesta_id", "clave", "tipo", "serie", "numero", "origen_existente", "campos",
        "valores_sire",
      ].sort(),
    );
    expect(c.columns.filter((x) => !x.notNull).map((x) => x.name)).toEqual([]);
  });

  it("campos es text[] y valores_sire jsonb", () => {
    const col = (n: string) => c.columns.find((x) => x.name === n)!;
    expect(col("campos").getSQLType()).toBe("text[]");
    expect(col("valores_sire").getSQLType()).toBe("jsonb");
  });

  it("FK compuesta (tenant_id, propuesta_id) -> propuesta(tenant_id, id) y FK a tenant(id)", () => {
    const f = fksCompuestas(c);
    expect(f).toContainEqual({
      desde: ["tenant_id", "propuesta_id"],
      hacia: "propuesta",
      destino: ["tenant_id", "id"],
    });
    expect(f.some((x) => x.hacia === "tenant" && x.desde[0] === "tenant_id")).toBe(true);
  });

  it("CHECK: campos no vacío y origen_existente sire|manual", () => {
    const todos = c.checks.map((k) => sqlDe(k.value)).join(" || ");
    expect(c.checks.length).toBeGreaterThanOrEqual(2);
    expect(todos).toContain("campos");
    expect(todos).toContain("'sire'");
    expect(todos).toContain("'manual'");
  });
});

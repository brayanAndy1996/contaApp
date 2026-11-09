import { getTableName } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  compra,
  compraHallazgo,
  compraOperacion,
  compraPeriodo,
  compraVersion,
} from "./compras";

// Spec 014 (T6, rojo): declaracion Drizzle de las cinco tablas de compras (0032 y 0033), sin BD. Las restricciones reales (RLS,
// trigger, grants, carreras) las prueban tests/aislamiento/compras-*.spec.ts. Hasta T11 falla porque `./compras` no existe.
// Nombres exportados: compra, compraVersion, compraOperacion, compraHallazgo y compraPeriodo (patron de ventas.ts); columnas y
// restricciones, las de plan.md (Contratos: BD) con `creada_en`/`deshecha_en`/`descartada_en`/`marcado_en` (013: ninguna `*_at`).
const dialecto = new PgDialect();
const sqlDe = (x: unknown) => dialecto.sqlToQuery(x as never).sql;

type Config = ReturnType<typeof getTableConfig>;
type Indice = {
  unique?: boolean;
  where?: unknown;
  columns: { name: string }[];
};
const indices = (c: Config) =>
  c.indexes.map((i) => i.config as unknown as Indice);
const unicas = (c: Config): string[][] => [
  ...c.uniqueConstraints.map((u) => u.columns.map((x) => x.name)),
  ...indices(c)
    .filter((i) => i.unique && i.where === undefined)
    .map((i) => i.columns.map((x) => x.name)),
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
const opcionales = (c: Config) =>
  c.columns
    .filter((x) => !x.notNull)
    .map((x) => x.name)
    .sort();
const MONTOS = [
  "bi_dg",
  "igv_dg",
  "bi_dgng",
  "igv_dgng",
  "bi_dng",
  "igv_dng",
  "no_gravado",
  "isc",
  "icbper",
  "otros_tributos",
  "total",
];

describe("esquema 014: compra", () => {
  const c = getTableConfig(compra);
  const col = (n: string) => c.columns.find((x) => x.name === n)!;

  it("se llama compra y tiene las columnas del plan, ninguna terminada en _at", () => {
    expect(getTableName(compra)).toBe("compra");
    expect(c.columns.map((x) => x.name).sort()).toEqual(
      [
        "id",
        "tenant_id",
        "cliente_id",
        "periodo",
        "propuesta_id",
        "clave",
        "tipo_doc",
        "serie",
        "numero",
        "doc_tipo",
        "doc_numero",
        "razon_social",
        "fecha",
        "moneda",
        "tipo_cambio",
        "origen",
        "version_vigente",
        "descartada_en",
        "creada_en",
      ].sort(),
    );
    expect(c.columns.filter((x) => /_at$/.test(x.name))).toEqual([]);
  });

  it("solo propuesta_id, razon_social, tipo_cambio y descartada_en son opcionales", () => {
    expect(opcionales(c)).toEqual([
      "descartada_en",
      "propuesta_id",
      "razon_social",
      "tipo_cambio",
    ]);
  });

  it("tipos del plan: periodo char(6), fecha date, version_vigente integer, tipo_cambio numeric; tenant_id sale del contexto", () => {
    expect(col("periodo").getSQLType()).toBe("char(6)");
    expect(col("fecha").getSQLType()).toBe("date");
    expect(col("version_vigente").getSQLType()).toBe("integer");
    expect(col("tipo_cambio").getSQLType()).toMatch(/^numeric/);
    expect(sqlDe(col("tenant_id").default)).toContain("app.tenant_id");
  });

  it("FK compuestas a cliente(tenant_id, id) y a propuesta(tenant_id, id)", () => {
    const f = fks(c);
    expect(f).toContainEqual({
      desde: ["tenant_id", "cliente_id"],
      hacia: "cliente",
      destino: ["tenant_id", "id"],
    });
    expect(f).toContainEqual({
      desde: ["tenant_id", "propuesta_id"],
      hacia: "propuesta",
      destino: ["tenant_id", "id"],
    });
  });

  it("unica (tenant_id, id) para las FK compuestas de las tablas hijas", () => {
    expect(unicas(c)).toContainEqual(["tenant_id", "id"]);
  });

  it("unica PARCIAL (tenant_id, cliente_id, periodo, clave) WHERE descartada_en IS NULL; ninguna unica total sobre la clave", () => {
    const parcial = indices(c).find((i) => i.unique && i.where !== undefined);
    expect(parcial, "falta la unica parcial de la clave viva").toBeDefined();
    expect(parcial!.columns.map((x) => x.name)).toEqual([
      "tenant_id",
      "cliente_id",
      "periodo",
      "clave",
    ]);
    expect(sqlDe(parcial!.where)).toMatch(/descartada_en.*is null/i);
    expect(unicas(c)).not.toContainEqual([
      "tenant_id",
      "cliente_id",
      "periodo",
      "clave",
    ]);
  });

  it("CHECK: origen sire|agregada, moneda PEN|USD, periodo AAAAMM y propuesta_id segun el origen", () => {
    const todos = c.checks.map((k) => sqlDe(k.value)).join(" || ");
    expect(todos).toContain("'sire'");
    expect(todos).toContain("'agregada'");
    expect(todos).not.toContain("'manual'");
    expect(todos).toContain("'PEN'");
    expect(todos).toContain("'USD'");
    expect(todos).toContain("propuesta_id");
    expect(todos).toContain("periodo");
  });
});

describe("esquema 014: compra_version", () => {
  const c = getTableConfig(compraVersion);
  const col = (n: string) => c.columns.find((x) => x.name === n)!;

  it("se llama compra_version y tiene las columnas del plan", () => {
    expect(getTableName(compraVersion)).toBe("compra_version");
    expect(c.columns.map((x) => x.name).sort()).toEqual(
      [
        "id",
        "tenant_id",
        "compra_id",
        "n",
        ...MONTOS,
        "excluida",
        "motivo",
        "clasificada",
        "accion",
        "operacion_id",
        "usuario_id",
        "creada_en",
      ].sort(),
    );
    expect(c.columns.filter((x) => /_at$/.test(x.name))).toEqual([]);
  });

  it("los 10 montos y el total son numeric(14, 2) NOT NULL: nunca doble precision ni entero", () => {
    for (const m of MONTOS) {
      expect(col(m).getSQLType(), m).toBe("numeric(14, 2)");
      expect(col(m).notNull, m).toBe(true);
    }
  });

  it("solo motivo, operacion_id y usuario_id son opcionales; motivo es varchar(200); n integer", () => {
    expect(opcionales(c)).toEqual(["motivo", "operacion_id", "usuario_id"]);
    expect(col("motivo").getSQLType()).toBe("varchar(200)");
    expect(col("n").getSQLType()).toBe("integer");
  });

  it("FK compuestas a compra(tenant_id, id) y a compra_operacion(tenant_id, id); unica (compra_id, n)", () => {
    const f = fks(c);
    expect(f).toContainEqual({
      desde: ["tenant_id", "compra_id"],
      hacia: "compra",
      destino: ["tenant_id", "id"],
    });
    expect(f).toContainEqual({
      desde: ["tenant_id", "operacion_id"],
      hacia: "compra_operacion",
      destino: ["tenant_id", "id"],
    });
    expect(
      unicas(c).some(
        (u) => u.includes("compra_id") && u.includes("n") && u.length <= 3,
      ),
    ).toBe(true);
  });
});

describe("esquema 014: compra_operacion", () => {
  const c = getTableConfig(compraOperacion);

  it("se llama compra_operacion y tiene las columnas del plan; solo referencia_id y deshecha_en son opcionales", () => {
    expect(getTableName(compraOperacion)).toBe("compra_operacion");
    expect(c.columns.map((x) => x.name).sort()).toEqual(
      [
        "id",
        "tenant_id",
        "cliente_id",
        "periodo",
        "usuario_id",
        "tipo",
        "estado",
        "referencia_id",
        "creada_en",
        "deshecha_en",
      ].sort(),
    );
    expect(opcionales(c)).toEqual(["deshecha_en", "referencia_id"]);
  });

  it("FK compuesta a cliente, unica (tenant_id, id) y CHECK del estado vigente|deshecha|caducada", () => {
    expect(fks(c)).toContainEqual({
      desde: ["tenant_id", "cliente_id"],
      hacia: "cliente",
      destino: ["tenant_id", "id"],
    });
    expect(unicas(c)).toContainEqual(["tenant_id", "id"]);
    const todos = c.checks.map((k) => sqlDe(k.value)).join(" || ");
    for (const e of ["vigente", "deshecha", "caducada"])
      expect(todos).toContain(`'${e}'`);
  });
});

describe("esquema 014: compra_hallazgo", () => {
  const c = getTableConfig(compraHallazgo);
  const col = (n: string) => c.columns.find((x) => x.name === n)!;

  it("se llama compra_hallazgo y tiene las columnas del plan; sugerencia y lecturas son jsonb", () => {
    expect(getTableName(compraHallazgo)).toBe("compra_hallazgo");
    expect(c.columns.map((x) => x.name).sort()).toEqual(
      [
        "id",
        "tenant_id",
        "compra_id",
        "version_n",
        "evaluacion_n",
        "regla",
        "sugerencia",
        "lecturas",
        "requiere_confirmacion",
        "creada_en",
      ].sort(),
    );
    expect(col("evaluacion_n").notNull).toBe(true);
    expect(col("sugerencia").getSQLType()).toBe("jsonb");
    expect(col("lecturas").getSQLType()).toBe("jsonb");
    expect(opcionales(c)).toEqual(["sugerencia"]);
  });

  it("FK compuesta a compra(tenant_id, id) y unica (compra_id, version_n, evaluacion_n, regla) (016 P-2)", () => {
    expect(fks(c)).toContainEqual({
      desde: ["tenant_id", "compra_id"],
      hacia: "compra",
      destino: ["tenant_id", "id"],
    });
    expect(
      unicas(c).some(
        (u) =>
          ["compra_id", "version_n", "evaluacion_n", "regla"].every((k) =>
            u.includes(k),
          ) && u.length <= 5,
      ),
    ).toBe(true);
  });
});

describe("esquema 014: compra_periodo", () => {
  const c = getTableConfig(compraPeriodo);

  it("se llama compra_periodo y tiene las columnas del plan; solo marcado_por y marcado_en son opcionales", () => {
    expect(getTableName(compraPeriodo)).toBe("compra_periodo");
    expect(c.columns.map((x) => x.name).sort()).toEqual(
      [
        "tenant_id",
        "cliente_id",
        "periodo",
        "estado",
        "marcado_por",
        "marcado_en",
      ].sort(),
    );
    expect(opcionales(c)).toEqual(["marcado_en", "marcado_por"]);
  });

  it("clave primaria (tenant_id, cliente_id, periodo), FK compuesta a cliente y CHECK abierto|revisado|generado", () => {
    expect(
      c.primaryKeys.map((p) => p.columns.map((x) => x.name)),
    ).toContainEqual(["tenant_id", "cliente_id", "periodo"]);
    expect(fks(c)).toContainEqual({
      desde: ["tenant_id", "cliente_id"],
      hacia: "cliente",
      destino: ["tenant_id", "id"],
    });
    const todos = c.checks.map((k) => sqlDe(k.value)).join(" || ");
    for (const e of ["abierto", "revisado", "generado"])
      expect(todos).toContain(`'${e}'`);
  });
});

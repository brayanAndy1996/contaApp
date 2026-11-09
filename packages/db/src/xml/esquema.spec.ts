import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as compras from "../schema/compras";
import * as xml from "../schema/xml";

// Spec 016 (T5, rojo): declaracion Drizzle de las tablas de las migraciones 0035 y 0036, sin BD. Las restricciones reales (RLS,
// grants, CHECK, backfill, carreras) las prueban tests/aislamiento/compras-xml-*.spec.ts. Hasta T11 falla porque `../schema/xml`
// no existe. Nombres exportados: `documentoXml` y `documentoXmlObtencion` desde schema/xml; `compraEvaluacion` desde schema/xml o
// schema/compras (el plan crea el primero y modifica el segundo: vale cualquiera); `compraHallazgo` gana `evaluacion_n`.
type Tabla = Parameters<typeof getTableConfig>[0];
const buscar = (nombre: string): Tabla => {
  const t =
    (xml as Record<string, unknown>)[nombre] ??
    (compras as Record<string, unknown>)[nombre];
  expect(
    t,
    `falta exportar la tabla ${nombre} (schema/xml o schema/compras)`,
  ).toBeDefined();
  return t as Tabla;
};

type Config = ReturnType<typeof getTableConfig>;
type Indice = {
  unique?: boolean;
  where?: unknown;
  columns: { name: string }[];
};
const unicas = (c: Config): string[][] => [
  ...c.uniqueConstraints.map((u) => u.columns.map((x) => x.name)),
  ...c.indexes
    .map((i) => i.config as unknown as Indice)
    .filter((i) => i.unique && i.where === undefined)
    .map((i) => i.columns.map((x) => x.name)),
  ...(c.primaryKeys ?? []).map((p) => p.columns.map((x) => x.name)),
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
const nombres = (c: Config) => c.columns.map((x) => x.name).sort();

describe("esquema 016: documento_xml", () => {
  const c = getTableConfig(buscar("documentoXml"));
  const col = (n: string) => c.columns.find((x) => x.name === n)!;

  it("se llama documento_xml y tiene las columnas del plan, ninguna terminada en _at", () => {
    expect(c.name).toBe("documento_xml");
    expect(nombres(c)).toEqual(
      [
        "id",
        "tenant_id",
        "cliente_id",
        "ruc_emisor",
        "tipo",
        "serie",
        "numero",
        "n",
        "origen",
        "ruta",
        "sha256",
        "tamano",
        "detalle",
        "subido_por",
        "creada_en",
      ].sort(),
    );
    expect(nombres(c).filter((n) => /_at$/.test(n))).toEqual([]);
  });

  it("sha256 es bytea, detalle jsonb, n y tamano enteros; solo subido_por admite nulo", () => {
    expect(col("sha256").getSQLType()).toBe("bytea");
    expect(col("detalle").getSQLType()).toBe("jsonb");
    expect([col("n").getSQLType(), col("tamano").getSQLType()]).toEqual([
      "integer",
      "integer",
    ]);
    expect(c.columns.filter((x) => !x.notNull).map((x) => x.name)).toEqual([
      "subido_por",
    ]);
  });

  it("FK compuesta a cliente(tenant_id, id) y unica (tenant_id, cliente_id, ruc_emisor, tipo, serie, numero, n)", () => {
    expect(fks(c)).toContainEqual({
      desde: ["tenant_id", "cliente_id"],
      hacia: "cliente",
      destino: ["tenant_id", "id"],
    });
    expect(
      unicas(c).some(
        (u) =>
          [
            "tenant_id",
            "cliente_id",
            "ruc_emisor",
            "tipo",
            "serie",
            "numero",
            "n",
          ].every((k) => u.includes(k)) && u.length === 7,
      ),
    ).toBe(true);
  });

  it("declara los CHECK de origen, subido_por y tamano", () => {
    expect(c.checks.length).toBeGreaterThanOrEqual(3);
  });
});

describe("esquema 016: documento_xml_obtencion", () => {
  const c = getTableConfig(buscar("documentoXmlObtencion"));

  it("se llama documento_xml_obtencion y tiene las columnas del plan", () => {
    expect(c.name).toBe("documento_xml_obtencion");
    expect(nombres(c)).toEqual(
      [
        "tenant_id",
        "cliente_id",
        "ruc_emisor",
        "tipo",
        "serie",
        "numero",
        "estado",
        "intentos",
        "actualizado_en",
      ].sort(),
    );
    expect(c.columns.filter((x) => !x.notNull)).toEqual([]);
  });

  it("clave primaria (tenant_id, cliente_id, ruc_emisor, tipo, serie, numero) y FK compuesta a cliente", () => {
    expect(c.primaryKeys.map((p) => p.columns.map((x) => x.name))).toEqual([
      ["tenant_id", "cliente_id", "ruc_emisor", "tipo", "serie", "numero"],
    ]);
    expect(fks(c)).toContainEqual({
      desde: ["tenant_id", "cliente_id"],
      hacia: "cliente",
      destino: ["tenant_id", "id"],
    });
  });

  it("declara el CHECK del estado (pendiente, no_encontrado, credencial, transitorio)", () => {
    expect(c.checks.length).toBeGreaterThanOrEqual(1);
  });
});

describe("esquema 016: compra_evaluacion y compra_hallazgo", () => {
  const e = getTableConfig(buscar("compraEvaluacion"));
  const h = getTableConfig(compras.compraHallazgo);

  it("compra_evaluacion: columnas del plan; solo documento_xml_id admite nulo", () => {
    expect(e.name).toBe("compra_evaluacion");
    expect(nombres(e)).toEqual(
      [
        "id",
        "tenant_id",
        "compra_id",
        "version_n",
        "n",
        "documento_xml_id",
        "creada_en",
      ].sort(),
    );
    expect(e.columns.filter((x) => !x.notNull).map((x) => x.name)).toEqual([
      "documento_xml_id",
    ]);
  });

  it("compra_evaluacion: FK compuestas a compra_version y documento_xml, y unica (tenant, compra, version, n)", () => {
    expect(fks(e)).toContainEqual({
      desde: ["tenant_id", "compra_id", "version_n"],
      hacia: "compra_version",
      destino: ["tenant_id", "compra_id", "n"],
    });
    expect(fks(e)).toContainEqual({
      desde: ["tenant_id", "documento_xml_id"],
      hacia: "documento_xml",
      destino: ["tenant_id", "id"],
    });
    expect(
      unicas(e).some(
        (u) =>
          ["tenant_id", "compra_id", "version_n", "n"].every((k) =>
            u.includes(k),
          ) && u.length === 4,
      ),
    ).toBe(true);
  });

  it("compra_hallazgo gana evaluacion_n NOT NULL, FK compuesta a compra_evaluacion y la unica incluye la evaluacion", () => {
    const col = h.columns.find((x) => x.name === "evaluacion_n");
    expect(col, "falta compra_hallazgo.evaluacion_n").toBeDefined();
    expect([col!.getSQLType(), col!.notNull, col!.hasDefault]).toEqual([
      "integer",
      true,
      false,
    ]);
    expect(fks(h)).toContainEqual({
      desde: ["tenant_id", "compra_id", "version_n", "evaluacion_n"],
      hacia: "compra_evaluacion",
      destino: ["tenant_id", "compra_id", "version_n", "n"],
    });
    const u = unicas(h);
    expect(
      u.some((x) =>
        ["compra_id", "version_n", "evaluacion_n", "regla"].every((k) =>
          x.includes(k),
        ),
      ),
    ).toBe(true);
    expect(
      u.some((x) => x.includes("regla") && !x.includes("evaluacion_n")),
      "la unica vieja (sin evaluacion_n) desaparece",
    ).toBe(false);
  });
});

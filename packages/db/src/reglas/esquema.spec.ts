// Spec 021 (T3, rojo): declaracion Drizzle de las tablas de las migraciones 0047-0049 y forma de los archivos de migracion, sin BD.
// Las restricciones reales (RLS, grants, CHECK, funciones, carreras) las prueban tests/aislamiento/reglas-*.spec.ts. Hasta T9 falla
// porque `../schema/reglas` y las migraciones no existen. Exporta `reglaAprendida`, `estudioReglaMotor`, `estudioReglasConfig`,
// `reglaAplicacion`, `reglaAceptacion` y `reglaConfirmacion` desde schema/reglas.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

const MIGRACIONES = resolve(__dirname, "../../migrations");
const cargar = async () => {
  try {
    return (await import("../schema/reglas.js")) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`falta packages/db/src/schema/reglas.ts (T9): ${String(e)}`);
  }
};
type Tabla = Parameters<typeof getTableConfig>[0];
const buscar = async (nombre: string): Promise<ReturnType<typeof getTableConfig>> => {
  const t = (await cargar())[nombre];
  expect(t, `falta exportar la tabla ${nombre} desde schema/reglas`).toBeDefined();
  return getTableConfig(t as Tabla);
};
const nombres = (c: ReturnType<typeof getTableConfig>) => c.columns.map((x) => x.name).sort();
const fks = (c: ReturnType<typeof getTableConfig>) =>
  c.foreignKeys.map((f) => {
    const r = f.reference();
    return {
      desde: r.columns.map((x) => x.name),
      hacia: getTableName(r.foreignTable),
      destino: r.foreignColumns.map((x) => x.name),
    };
  });

describe("esquema 021: regla_aprendida", () => {
  it("se llama regla_aprendida y tiene las columnas del plan, ninguna terminada en _at", async () => {
    const c = await buscar("reglaAprendida");
    expect(c.name).toBe("regla_aprendida");
    expect(nombres(c)).toEqual(
      [
        "id", "tenant_id", "cliente_id", "doc_tipo", "doc_numero", "destino", "activa", "version", "periodo_aprendido",
        "creada_por", "creada_en", "actualizada_por", "actualizada_en", "eliminada_en", "eliminada_por",
      ].sort(),
    );
    expect(nombres(c).filter((n) => /_at$/.test(n))).toEqual([]);
  });

  it("version entero, periodo_aprendido char(6); solo eliminada_en y eliminada_por admiten nulo", async () => {
    const c = await buscar("reglaAprendida");
    const col = (n: string) => c.columns.find((x) => x.name === n)!;
    expect(col("version").getSQLType()).toBe("integer");
    expect(col("periodo_aprendido").getSQLType()).toMatch(/char\(6\)/);
    expect(c.columns.filter((x) => !x.notNull).map((x) => x.name).sort()).toEqual(["eliminada_en", "eliminada_por"]);
  });

  it("FK compuesta a cliente(tenant_id, id), CHECK de destino y version, y unica parcial con baja logica", async () => {
    const c = await buscar("reglaAprendida");
    expect(fks(c)).toContainEqual({ desde: ["tenant_id", "cliente_id"], hacia: "cliente", destino: ["tenant_id", "id"] });
    expect(c.checks.length).toBeGreaterThanOrEqual(2);
    const parcial = c.indexes
      .map((i) => i.config as unknown as { unique?: boolean; where?: unknown; columns: { name: string }[] })
      .find((i) => i.unique && i.where !== undefined);
    expect(parcial?.columns.map((x) => x.name)).toEqual(["tenant_id", "cliente_id", "doc_tipo", "doc_numero"]);
  });
});

describe("esquema 021: el resto de las tablas", () => {
  it("estudio_regla_motor (PK tenant_id + codigo) y estudio_reglas_config (PK tenant_id)", async () => {
    const m = await buscar("estudioReglaMotor");
    expect(m.name).toBe("estudio_regla_motor");
    expect(nombres(m)).toEqual(["activa", "actualizada_en", "actualizada_por", "codigo", "tenant_id"]);
    expect(m.primaryKeys.map((p) => p.columns.map((x) => x.name))).toEqual([["tenant_id", "codigo"]]);
    expect(m.checks.length).toBeGreaterThanOrEqual(1);
    const k = await buscar("estudioReglasConfig");
    expect(k.name).toBe("estudio_reglas_config");
    expect(nombres(k)).toEqual(expect.arrayContaining(["tenant_id", "aportar_catalogo"]));
  });

  it("regla_aplicacion: FK compuestas a regla_aprendida y a compra_version; version_n entero", async () => {
    const c = await buscar("reglaAplicacion");
    expect(c.name).toBe("regla_aplicacion");
    expect(nombres(c)).toEqual(["compra_id", "creada_en", "id", "periodo", "regla_id", "tenant_id", "version_n"]);
    const f = fks(c);
    expect(f).toContainEqual({ desde: ["tenant_id", "regla_id"], hacia: "regla_aprendida", destino: ["tenant_id", "id"] });
    expect(f).toContainEqual({ desde: ["tenant_id", "compra_id", "version_n"], hacia: "compra_version", destino: ["tenant_id", "compra_id", "n"] });
  });

  it("regla_aceptacion y regla_confirmacion: columnas del plan y ninguna columna de usuario, monto ni razon social en la confirmacion", async () => {
    const a = await buscar("reglaAceptacion");
    expect(a.name).toBe("regla_aceptacion");
    expect(nombres(a)).toEqual(expect.arrayContaining(["regla_aplicacion_id", "regla_id", "periodo", "creada_en", "tenant_id"]));
    const k = await buscar("reglaConfirmacion");
    expect(k.name).toBe("regla_confirmacion");
    expect(nombres(k)).toEqual(
      ["cliente_id", "creada_en", "destino", "id", "origen", "regla_id", "ruc_proveedor", "tenant_id"],
    );
    expect(k.checks.length).toBeGreaterThanOrEqual(1);
  });
});

describe("archivos de migracion 0047-0049", () => {
  const ARCHIVOS = ["0047_regla_aprendida.sql", "0048_regla_aplicacion.sql", "0049_regla_confirmacion.sql"];

  it.each(ARCHIVOS)("existe %s", (f) => {
    expect(existsSync(`${MIGRACIONES}/${f}`), `falta migrations/${f}`).toBe(true);
  });

  it("el diario tiene las entradas 47, 48 y 49 con esas etiquetas", () => {
    const j = JSON.parse(readFileSync(`${MIGRACIONES}/meta/_journal.json`, "utf8")) as {
      entries: { idx: number; tag: string }[];
    };
    const e = Object.fromEntries(j.entries.map((x) => [x.idx, x.tag]));
    expect([e[47], e[48], e[49]]).toEqual(ARCHIVOS.map((f) => f.replace(".sql", "")));
  });

  const sql = (f: string) => (existsSync(`${MIGRACIONES}/${f}`) ? readFileSync(`${MIGRACIONES}/${f}`, "utf8") : "");

  it("0047 y 0049 crean tablas con RLS ENABLE y FORCE; ninguna concede DELETE a un rol de la app", () => {
    for (const f of [ARCHIVOS[0]!, ARCHIVOS[1]!, ARCHIVOS[2]!]) {
      const s = sql(f);
      expect(s, f).not.toBe("");
      const tablas = [...s.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?"?(?:public"?\.)?"?(\w+)"?/gi)].map((m) => m[1]!);
      for (const t of tablas) {
        expect(s, `${f}: ENABLE RLS en ${t}`).toMatch(new RegExp(`ALTER TABLE\\s+(?:"?public"?\\.)?"?${t}"?\\s+ENABLE ROW LEVEL SECURITY`, "i"));
        expect(s, `${f}: FORCE RLS en ${t}`).toMatch(new RegExp(`ALTER TABLE\\s+(?:"?public"?\\.)?"?${t}"?\\s+FORCE ROW LEVEL SECURITY`, "i"));
      }
      expect(s, `${f}: GRANT DELETE`).not.toMatch(/GRANT[^;]*\bDELETE\b[^;]*TO\s+contapp_(backend|worker|app|platform)/i);
    }
  });

  it("0048: las dos funciones son SECURITY DEFINER con search_path fijo y EXECUTE solo para contapp_worker", () => {
    const s = sql(ARCHIVOS[1]!);
    for (const f of ["reglas_historial_vigentes", "aplicar_regla_historial"]) {
      expect(s, `${f} definida`).toMatch(new RegExp(`CREATE OR REPLACE FUNCTION\\s+public\\.${f}`, "i"));
      expect(s, `${f}: EXECUTE al worker`).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION\\s+public\\.${f}[^;]*TO contapp_worker`, "i"));
      expect(s, `${f}: dueno migrator`).toMatch(new RegExp(`ALTER FUNCTION\\s+public\\.${f}[^;]*OWNER TO contapp_migrator`, "i"));
    }
    expect((s.match(/SECURITY DEFINER SET search_path = pg_catalog, pg_temp/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(s).not.toMatch(/GRANT EXECUTE ON FUNCTION[^;]*TO\s+(PUBLIC|contapp_backend)/i);
  });

  it("las migraciones son repetibles: sin DROP TABLE ni DROP COLUMN, y los triggers con DROP TRIGGER IF EXISTS", () => {
    for (const f of ARCHIVOS) {
      const s = sql(f);
      expect(s, f).not.toBe("");
      expect(s, f).not.toMatch(/DROP TABLE|DROP COLUMN/i);
      for (const m of s.matchAll(/CREATE TRIGGER\s+(\w+)/gi)) {
        expect(s, `${f}: DROP TRIGGER IF EXISTS ${m[1]}`).toMatch(new RegExp(`DROP TRIGGER IF EXISTS\\s+${m[1]}\\b`, "i"));
      }
    }
  });
});

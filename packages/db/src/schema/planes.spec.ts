import { getTableName } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { adminPlataforma, plan, suscripcion } from "./planes";

// Spec 006 (T11, cobertura): declaración Drizzle de `plan`, `suscripcion` y `admin_plataforma`, sin BD. Recorre los
// callbacks perezosos de checks, únicos y claves foráneas. Los privilegios, la RLS y las restricciones reales las
// prueban tests/aislamiento/planes*.spec.ts.
const dialecto = new PgDialect();
const sqlDe = (x: unknown) => dialecto.sqlToQuery(x as never).sql;
const checks = (t: Parameters<typeof getTableConfig>[0]) =>
  Object.fromEntries(getTableConfig(t).checks.map((c) => [c.name, sqlDe(c.value)]));
const columnas = (t: Parameters<typeof getTableConfig>[0]) => getTableConfig(t).columns.map((c) => c.name);

describe("plan", () => {
  it("tabla `plan` de plataforma: sin tenant_id y con codigo único", () => {
    const c = getTableConfig(plan);
    expect(c.name).toBe("plan");
    expect(columnas(plan)).not.toContain("tenant_id");
    expect(columnas(plan)).toEqual(
      expect.arrayContaining([
        "id", "codigo", "nombre", "precio_mensual", "precio_anual", "max_rucs", "max_usuarios", "precio_ruc_extra",
        "max_rucs_extra", "frecuencia_buzon_min", "features", "activo",
      ]),
    );
    expect(c.columns.find((x) => x.name === "codigo")?.isUnique).toBe(true);
  });

  it("montos NUMERIC(14,2) y máximo de usuarios nulo (sin límite)", () => {
    const c = getTableConfig(plan).columns;
    for (const n of ["precio_mensual", "precio_anual", "precio_ruc_extra"])
      expect(c.find((x) => x.name === n)?.getSQLType()).toBe("numeric(14, 2)");
    expect(c.find((x) => x.name === "max_usuarios")?.notNull).toBe(false);
    expect(c.find((x) => x.name === "precio_anual")?.notNull).toBe(false);
  });

  it("los CHECK fijan montos, límites, tope de RUC adicionales (20 %) y features como objeto", () => {
    const k = checks(plan);
    expect(Object.keys(k).sort()).toEqual([
      "plan_features_objeto",
      "plan_frecuencia_buzon_positiva",
      "plan_max_rucs_extra_tope",
      "plan_max_rucs_positivo",
      "plan_max_usuarios_positivo",
      "plan_precio_anual_no_negativo",
      "plan_precio_mensual_no_negativo",
      "plan_precio_ruc_extra_no_negativo",
    ]);
    expect(k.plan_max_rucs_extra_tope).toContain("* 5");
    expect(k.plan_features_objeto).toContain("jsonb_typeof");
    expect(k.plan_max_rucs_positivo).toContain(">= 1");
  });
});

describe("suscripcion", () => {
  it("una por estudio: tenant_id NOT NULL, único y con FK a tenant y a plan", () => {
    const c = getTableConfig(suscripcion);
    expect(c.columns.find((x) => x.name === "tenant_id")?.notNull).toBe(true);
    expect(c.uniqueConstraints.map((u) => u.name)).toEqual(["suscripcion_tenant_unique"]);
    const destinos = c.foreignKeys.map((fk) => getTableName(fk.reference().foreignTable)).sort();
    expect(destinos).toEqual(["plan", "tenant"]);
  });

  it("los CHECK limitan el estado a prueba/activa y exigen vencimiento en prueba", () => {
    const k = checks(suscripcion);
    expect(Object.keys(k).sort()).toEqual([
      "suscripcion_estado_valido",
      "suscripcion_prueba_vence",
      "suscripcion_rucs_extra_no_negativo",
    ]);
    expect(k.suscripcion_estado_valido).toContain("'prueba'");
    expect(k.suscripcion_estado_valido).toContain("'activa'");
    expect(k.suscripcion_prueba_vence).toContain("prueba_vence_en");
  });
});

describe("admin_plataforma", () => {
  it("la clave primaria es usuario_id con FK a usuario", () => {
    const c = getTableConfig(adminPlataforma);
    expect(c.columns.find((x) => x.name === "usuario_id")?.primary).toBe(true);
    expect(c.foreignKeys.map((fk) => getTableName(fk.reference().foreignTable))).toEqual(["usuario"]);
  });
});

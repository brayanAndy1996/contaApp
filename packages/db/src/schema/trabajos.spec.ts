import { getTableName } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { configSistema, jobRegistro } from "./trabajos";

// Spec 008 (T11 de 006, cobertura): declaración Drizzle de `job_registro` y `config_sistema`, sin BD. Recorre los callbacks
// perezosos (índices, claves foráneas, CHECK) y el tipo bytea. Las restricciones reales las prueban
// tests/aislamiento/trabajos*.spec.ts.
const dialecto = new PgDialect();
const sqlDe = (x: unknown) => dialecto.sqlToQuery(x as never).sql;

describe("job_registro", () => {
  const c = getTableConfig(jobRegistro);

  it("la clave de deduplicación es bytea y el tenant_id es obligatorio", () => {
    const clave = c.columns.find((x) => x.name === "clave_dedupe");
    expect(clave?.getSQLType()).toBe("bytea");
    expect(clave?.notNull).toBe(true);
    expect(c.columns.find((x) => x.name === "tenant_id")?.notNull).toBe(true);
  });

  it("claves foráneas compuestas (tenant_id, cliente) y (tenant_id, creado_por)", () => {
    const fks = c.foreignKeys.map((fk) => {
      const r = fk.reference();
      return {
        nombre: fk.getName(),
        desde: r.columns.map((x) => x.name),
        hacia: getTableName(r.foreignTable),
        destino: r.foreignColumns.map((x) => x.name),
      };
    });
    expect(fks.filter((f) => f.hacia !== "tenant")).toEqual([
      {
        nombre: "job_registro_cliente_fk",
        desde: ["tenant_id", "cliente_id"],
        hacia: "cliente",
        destino: ["tenant_id", "id"],
      },
      {
        nombre: "job_registro_creado_por_fk",
        desde: ["tenant_id", "creado_por"],
        hacia: "membresia",
        destino: ["tenant_id", "usuario_id"],
      },
    ]);
    expect(fks.filter((f) => f.hacia === "tenant")).toHaveLength(1);
  });

  it("índices: un solo trabajo vivo por clave (parcial) y los de despacho y cliente, todos con tenant_id primero", () => {
    type Indice = { name: string; unique: boolean; where?: unknown; columns: Array<{ name: string }> };
    const porNombre: Record<string, Indice> = {};
    for (const i of c.indexes) porNombre[String(i.config.name)] = i.config as unknown as Indice;
    expect(Object.keys(porNombre).sort()).toEqual([
      "job_registro_cliente_idx",
      "job_registro_dedupe_vivo",
      "job_registro_despacho_idx",
    ]);
    expect(porNombre.job_registro_dedupe_vivo!.unique).toBe(true);
    expect(sqlDe(porNombre.job_registro_dedupe_vivo!.where)).toContain("'en_cola', 'ejecutando'");
    for (const i of Object.values(porNombre)) expect(i.columns[0]!.name).toBe("tenant_id");
  });

  it("los CHECK acotan cola, canal, prioridad, estado, motivo, RUC, tamaños e intentos", () => {
    const k = Object.fromEntries(c.checks.map((x) => [x.name, sqlDe(x.value)]));
    expect(Object.keys(k)).toHaveLength(12);
    expect(k.job_registro_cola_valida).toContain("'notificaciones'");
    expect(k.job_registro_estado_valido).toContain("'cancelado'");
    expect(k.job_registro_motivo_valido).toContain("'credencial_invalida'");
    expect(k.job_registro_ruc_11_digitos).toContain("[0-9]{11}");
    expect(k.job_registro_clave_dedupe_32).toContain("= 32");
    expect(k.job_registro_parametros_tamano).toContain("4096");
  });
});

describe("config_sistema", () => {
  const c = getTableConfig(configSistema);

  it("tabla de plataforma (sin tenant_id) con CHECK de cola y de rangos", () => {
    expect(c.name).toBe("config_sistema");
    expect(c.columns.map((x) => x.name)).not.toContain("tenant_id");
    const k = Object.fromEntries(c.checks.map((x) => [x.name, sqlDe(x.value)]));
    expect(Object.keys(k).sort()).toEqual([
      "config_sistema_backoff_base",
      "config_sistema_cola_valida",
      "config_sistema_concurrencia_global",
      "config_sistema_concurrencia_tenant",
      "config_sistema_espera_ruc",
      "config_sistema_max_pendientes",
      "config_sistema_reintentos",
    ]);
    expect(k.config_sistema_concurrencia_tenant).toContain("greatest(1,");
    expect(k.config_sistema_cola_valida).toContain("'sire'");
  });
});

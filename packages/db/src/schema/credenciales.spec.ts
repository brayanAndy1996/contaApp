import { getTableName } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { auditoriaDescifrado, credencial } from "./credenciales";

// Pruebas sin BD de la declaración de las tablas de 003 (los permisos y la RLS los prueba tests/aislamiento).
const dialecto = new PgDialect();
const sqlDe = (x: unknown) => dialecto.sqlToQuery(x as never).sql;

describe("esquema 003: credencial", () => {
  const c = getTableConfig(credencial);

  it("columnas del sobre en bytea y tenant_id NOT NULL tomado del contexto", () => {
    for (const n of ["ciphertext", "nonce", "tag", "dek_envuelta"]) {
      const col = c.columns.find((x) => x.name === n);
      expect(col?.getSQLType(), n).toBe("bytea");
      expect(col?.notNull, n).toBe(true);
    }
    const t = c.columns.find((x) => x.name === "tenant_id");
    expect(t?.notNull).toBe(true);
    expect(sqlDe(t?.default)).toContain("app.tenant_id");
  });

  it("UNIQUE (tenant_id, cliente_id, tipo) y FK a tenant(id)", () => {
    expect(
      c.uniqueConstraints.map((u) => u.columns.map((x) => x.name)),
    ).toEqual([["tenant_id", "cliente_id", "tipo"]]);
    const fk = c.foreignKeys[0].reference();
    expect(getTableName(fk.foreignTable)).toBe("tenant");
    expect(fk.columns.map((x) => x.name)).toEqual(["tenant_id"]);
  });

  it("CHECK de tipo, tamaños del sobre, kek_id y version", () => {
    const checks = Object.fromEntries(
      c.checks.map((k) => [k.name, sqlDe(k.value)]),
    );
    expect(Object.keys(checks).sort()).toEqual([
      "credencial_ciphertext_largo",
      "credencial_dek_envuelta_largo",
      "credencial_kek_id_formato",
      "credencial_nonce_12",
      "credencial_tag_16",
      "credencial_tipo_valido",
      "credencial_version_1",
    ]);
    expect(checks.credencial_nonce_12).toContain("= 12");
    expect(checks.credencial_tag_16).toContain("= 16");
    expect(checks.credencial_ciphertext_largo).toContain("BETWEEN 1 AND 1100");
  });
});

describe("esquema 003: auditoria_descifrado", () => {
  const c = getTableConfig(auditoriaDescifrado);

  it("solo inserción: sin updated_at; cliente_id y tipo opcionales", () => {
    const nombres = c.columns.map((x) => x.name).sort();
    expect(nombres).toEqual([
      "cliente_id",
      "created_at",
      "credencial_id",
      "id",
      "motivo",
      "resultado",
      "tenant_id",
      "tipo",
    ]);
    expect(c.columns.find((x) => x.name === "cliente_id")?.notNull).toBe(false);
    expect(c.columns.find((x) => x.name === "tipo")?.notNull).toBe(false);
    expect(getTableName(c.foreignKeys[0].reference().foreignTable)).toBe(
      "tenant",
    );
  });

  it("CHECK de motivo, resultado y tipo", () => {
    expect(c.checks.map((k) => k.name).sort()).toEqual([
      "auditoria_descifrado_motivo_formato",
      "auditoria_descifrado_resultado_valido",
      "auditoria_descifrado_tipo_valido",
    ]);
  });
});

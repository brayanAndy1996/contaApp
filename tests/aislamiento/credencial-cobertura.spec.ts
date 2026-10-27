import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { CredencialRepoError, auditoriaDescifrado, credencial } from "@contapp/db";

// drizzle-orm es dependencia de packages/db, no de tests/: se resuelve desde ese paquete.
const requireDb = createRequire(
  new URL("../../packages/db/package.json", import.meta.url),
);
const importar = (m: string) => import(pathToFileURL(requireDb.resolve(m)).href);
const { getTableName } = await importar("drizzle-orm");
const { getTableConfig } = await importar("drizzle-orm/pg-core");

// Cobertura sin BD de la parte de 003 en packages/db (error de repositorio y declaración de tablas).
// Vive aquí para correr tanto en `cobertura:crypto` como en `cobertura:db`.

describe("CredencialRepoError.desde: ramas de reducción a SQLSTATE", () => {
  it.each([
    ["código SQLSTATE válido", { code: "42501" }, "42501"],
    ["SQLSTATE con letras", { code: "2BP01" }, "2BP01"],
    ["sin propiedad code", {}, "desconocido"],
    ["code numérico", { code: 23514 }, "desconocido"],
    ["code en minúsculas", { code: "42p01" }, "desconocido"],
    ["code de largo incorrecto", { code: "4250" }, "desconocido"],
    ["undefined", undefined, "desconocido"],
    ["null", null, "desconocido"],
    ["texto", "42501", "desconocido"],
    ["número", 42501, "desconocido"],
  ])("%s", (_n, error, esperado) => {
    const e = CredencialRepoError.desde(error);
    expect(e).toBeInstanceOf(CredencialRepoError);
    expect(e.codigo).toBe(esperado);
    expect(e.message).toBe(
      `Error de base de datos en credenciales (SQLSTATE ${esperado})`,
    );
    expect(e.name).toBe("CredencialRepoError");
  });
});

describe("tablas de 003: configuración declarada", () => {
  it("credencial: referencia a tenant, unicidad y checks evaluados", () => {
    const c = getTableConfig(credencial);
    expect(c.name).toBe("credencial");
    expect(getTableName(c.foreignKeys[0].reference().foreignTable)).toBe("tenant");
    expect(c.uniqueConstraints).toHaveLength(1);
    expect(c.checks).toHaveLength(7);
  });

  it("auditoria_descifrado: referencia a tenant y checks evaluados", () => {
    const c = getTableConfig(auditoriaDescifrado);
    expect(c.name).toBe("auditoria_descifrado");
    expect(getTableName(c.foreignKeys[0].reference().foreignTable)).toBe("tenant");
    expect(c.checks).toHaveLength(3);
  });
});

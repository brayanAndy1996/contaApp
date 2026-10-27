// Spec 008 (T3, rojo): TrabajosRepoError conserva solo el SQLSTATE (mismo patron que CredencialRepoError y AccesoRepoError).
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { TrabajosRepoError } from "./errores";
import { errorPg } from "./soporte-prueba";

describe("TrabajosRepoError.desde", () => {
  it("conserva solo el SQLSTATE de un error de pg (sin detail, constraint, table, column, where ni cause)", () => {
    const e = TrabajosRepoError.desde(errorPg("23514"));
    expect(e).toBeInstanceOf(TrabajosRepoError);
    expect(e).toBeInstanceOf(Error);
    expect(e.codigo).toBe("23514");
    for (const k of ["detail", "constraint", "table", "column", "where"]) expect(e).not.toHaveProperty(k);
    expect(e.cause).toBeUndefined();
    expect(inspect(e) + JSON.stringify(e) + e.message + String(e.stack)).not.toContain("CANARIO-SOL-123");
  });

  it("el mensaje es fijo y menciona solo el SQLSTATE", () => {
    const a = TrabajosRepoError.desde(errorPg("23505", "CANARIO-A"));
    const b = TrabajosRepoError.desde(errorPg("23505", "CANARIO-B"));
    expect(a.message).toBe(b.message);
    expect(a.message).toContain("23505");
  });

  it("el constructor directo tambien guarda solo el codigo", () => {
    const e = new TrabajosRepoError("40001");
    expect(e.codigo).toBe("40001");
    expect(e.name).toBe("TrabajosRepoError");
  });

  it.each([
    ["sin code", new Error("ECONNRESET")],
    ["code que no es SQLSTATE", { code: "ECONNREFUSED" }],
    ["code en minusculas", { code: "42p01" }],
    ["code numerico", { code: 42501 }],
    ["valor no objeto", "texto"],
    ["undefined", undefined],
    ["null", null],
  ])("%s -> codigo 'desconocido'", (_n, error) => {
    expect(TrabajosRepoError.desde(error).codigo).toBe("desconocido");
  });
});

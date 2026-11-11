// Spec 012b (T4, rojo): ArchivosRepoError conserva solo el SQLSTATE (mismo patron que VentasRepoError y ComprasRepoError): nunca el
// mensaje original, detail, constraint, table, column ni cause (pueden traer la ruta, los hashes o el nombre del ZIP). Unitaria:
// no usa Postgres. Hasta T10 falla porque `./errores` no existe.
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { ArchivosRepoError } from "./errores";

describe("ArchivosRepoError.desde", () => {
  it("conserva solo el SQLSTATE de un error de pg, sin detail, constraint ni cause", () => {
    const origen = Object.assign(
      new Error("fila con CANARIO-RUTA archivos/x/y/z.zip"),
      {
        code: "23514",
        detail: "CANARIO-HASH",
        constraint: "archivo_generado_ruta_formato",
        table: "archivo_generado",
      },
    );
    const e = ArchivosRepoError.desde(origen);
    expect(e).toBeInstanceOf(ArchivosRepoError);
    expect(e.codigo).toBe("23514");
    for (const k of ["detail", "constraint", "table", "column", "where"])
      expect(e).not.toHaveProperty(k);
    expect(e.cause).toBeUndefined();
    const texto = inspect(e) + JSON.stringify(e) + e.message + String(e.stack);
    expect(texto).not.toContain("CANARIO");
    expect(texto).not.toContain("archivos/x/y/z.zip");
    expect(e.message).toContain("23514");
  });

  it("el constructor directo guarda el codigo y el nombre", () => {
    const e = new ArchivosRepoError("23505");
    expect(e.codigo).toBe("23505");
    expect(e.name).toBe("ArchivosRepoError");
    expect(e).toBeInstanceOf(Error);
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
    expect(ArchivosRepoError.desde(error).codigo).toBe("desconocido");
  });
});

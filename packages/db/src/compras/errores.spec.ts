// Spec 014 (T6, rojo): errores de los repositorios de compras. ComprasRepoError conserva solo el SQLSTATE (mismo patron que
// VentasRepoError y PropuestasRepoError); ComprasReglaError lleva el codigo de negocio que el backend traduce a HTTP
// (version_obsoleta, fila_excluida, fila_cambiada, duplicado, no_descartable, no_encontrada, nada_que_deshacer, nada_que_rehacer
// y los rechazos que devuelve `transformar`). Unitarias: no usan Postgres.
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { ComprasReglaError, ComprasRepoError } from "./errores";

describe("ComprasRepoError.desde", () => {
  it("conserva solo el SQLSTATE de un error de pg, sin detail, constraint ni cause", () => {
    const origen = Object.assign(new Error("fila con CANARIO-SECRETO"), {
      code: "23505",
      detail: "CANARIO-SECRETO",
      constraint: "compra_clave_viva_unique",
    });
    const e = ComprasRepoError.desde(origen);
    expect(e).toBeInstanceOf(ComprasRepoError);
    expect(e.codigo).toBe("23505");
    for (const k of ["detail", "constraint", "table", "column", "where"])
      expect(e).not.toHaveProperty(k);
    expect(e.cause).toBeUndefined();
    expect(
      inspect(e) + JSON.stringify(e) + e.message + String(e.stack),
    ).not.toContain("CANARIO-SECRETO");
    expect(e.message).toContain("23505");
  });

  it("el constructor directo guarda el codigo y el nombre", () => {
    const e = new ComprasRepoError("40001");
    expect(e.codigo).toBe("40001");
    expect(e.name).toBe("ComprasRepoError");
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
    expect(ComprasRepoError.desde(error).codigo).toBe("desconocido");
  });

  it("un ComprasReglaError no se disfraza de error de base de datos (pasa tal cual por desde → desconocido)", () => {
    expect(
      ComprasRepoError.desde(
        new ComprasReglaError("version_obsoleta", { versionVigente: 2 }),
      ).codigo,
    ).toBe("desconocido");
  });
});

describe("ComprasReglaError", () => {
  it("version_obsoleta lleva la version vigente", () => {
    const e = new ComprasReglaError("version_obsoleta", { versionVigente: 3 });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ComprasReglaError");
    expect(e.codigo).toBe("version_obsoleta");
    expect(e.versionVigente).toBe(3);
    expect(e.ids).toBeUndefined();
  });

  it("fila_cambiada y duplicado llevan los ids de las filas", () => {
    const ids = [
      "0198f0c8-0000-7000-8000-000000000001",
      "0198f0c8-0000-7000-8000-000000000002",
    ];
    const e = new ComprasReglaError("fila_cambiada", { ids });
    expect(e.codigo).toBe("fila_cambiada");
    expect([...(e.ids ?? [])]).toEqual(ids);
    expect(new ComprasReglaError("duplicado", { ids: [ids[0]] }).ids).toEqual([
      ids[0],
    ]);
  });

  it("los codigos sin detalle (no_encontrada, nada_que_deshacer...) no inventan ids ni version", () => {
    for (const codigo of [
      "no_encontrada",
      "nada_que_deshacer",
      "nada_que_rehacer",
      "fila_excluida",
      "no_descartable",
    ]) {
      const e = new ComprasReglaError(codigo);
      expect(e.codigo).toBe(codigo);
      expect(e.ids).toBeUndefined();
      expect(e.versionVigente).toBeUndefined();
    }
  });

  it("acepta cualquier rechazo que devuelva transformar (requiere_dato, revisar_de_nuevo, no_masiva)", () => {
    for (const codigo of ["requiere_dato", "revisar_de_nuevo", "no_masiva"])
      expect(new ComprasReglaError(codigo).codigo).toBe(codigo);
  });

  it("el mensaje es fijo: lleva el codigo y nunca los ids ni datos de la fila", () => {
    const e = new ComprasReglaError("fila_cambiada", {
      ids: ["0198f0c8-0000-7000-8000-00000000abcd"],
    });
    expect(e.message).toContain("fila_cambiada");
    expect(e.message).not.toContain("0198f0c8");
    expect(inspect(e, { depth: 0 })).not.toContain("CANARIO");
  });
});

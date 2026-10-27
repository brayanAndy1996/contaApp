import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { CredencialRepoError } from "./errores";

describe("CredencialRepoError.desde", () => {
  it("conserva solo el SQLSTATE de un error de pg", () => {
    const pg = Object.assign(new Error("violates check constraint x"), {
      code: "23514",
      detail: "Failing row contains (CANARIO)",
      constraint: "credencial_nonce_12",
    });
    const e = CredencialRepoError.desde(pg);
    expect(e).toBeInstanceOf(CredencialRepoError);
    expect(e.codigo).toBe("23514");
    expect(e).not.toHaveProperty("detail");
    expect(e.cause).toBeUndefined();
    expect(inspect(e) + JSON.stringify(e)).not.toContain("CANARIO");
  });

  it.each([
    ["sin code", new Error("ECONNRESET")],
    ["code que no es SQLSTATE", { code: "ECONNREFUSED" }],
    ["valor no objeto", "texto"],
    ["null", null],
  ])("%s → codigo 'desconocido'", (_n, error) => {
    expect(CredencialRepoError.desde(error).codigo).toBe("desconocido");
  });
});

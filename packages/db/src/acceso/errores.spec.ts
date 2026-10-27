// Spec 005 (T2, rojo): AccesoRepoError (mismo patrón que AuthRepoError de 004, CA-14): del error de pg solo
// conserva el SQLSTATE (en `codigo`); sin message original, detail, where, constraint, table, column ni cause.
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { AccesoRepoError } from "./errores";

describe("AccesoRepoError.desde", () => {
  it("conserva el SQLSTATE, nombra la clase y no filtra campos de pg", () => {
    const e = AccesoRepoError.desde({ code: "23505", detail: "CANARIO", message: "CANARIO", constraint: "CANARIO" });
    expect(e).toBeInstanceOf(AccesoRepoError);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("AccesoRepoError");
    expect(e.codigo).toBe("23505");
    expect(e.message).not.toContain("CANARIO");
    expect(Object.keys(e).sort()).toEqual(["codigo"]);
    const volcado = `${e.message}\n${e.stack}\n${JSON.stringify(e)}\n${inspect(e, { depth: 6, showHidden: true })}`;
    expect(volcado).not.toContain("CANARIO");
  });

  it("conserva el SQLSTATE propio del trigger del último Dueño (P0001)", () => {
    expect(AccesoRepoError.desde({ code: "P0001", message: "texto del RAISE" }).codigo).toBe("P0001");
  });

  it.each([undefined, null, "23505", 23505, {}, { code: "" }, { code: "abcde" }, { code: "2350" }, { code: "235055" }, new Error("x")])(
    "una entrada sin SQLSTATE válido (%j) da 'desconocido'",
    (entrada) => {
      expect(AccesoRepoError.desde(entrada).codigo).toBe("desconocido");
    },
  );
});

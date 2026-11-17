// Spec 023, T15: BuzonRepoError y consultar() solo conservan el SQLSTATE; nunca el texto del error.
import { describe, expect, it } from "vitest";
import { BuzonRepoError, consultar, type TxConsulta } from "./errores";

describe("BuzonRepoError.desde", () => {
  it("conserva un SQLSTATE válido y descarta el mensaje y los datos del error de pg", () => {
    const e = BuzonRepoError.desde({
      code: "23503",
      message: "clave foránea con asunto SECRETO",
      detail: "Key (nombre)=(factura.pdf)",
    });
    expect(e).toBeInstanceOf(BuzonRepoError);
    expect(e.codigo).toBe("23503");
    expect(e.name).toBe("BuzonRepoError");
    expect(e.message).toBe("Error de base de datos en buzón (SQLSTATE 23503)");
    expect(JSON.stringify(e)).not.toContain("SECRETO");
    expect(e.message).not.toContain("factura");
  });

  it("acepta SQLSTATE con letras mayúsculas (42501, P0001)", () => {
    expect(BuzonRepoError.desde({ code: "42501" }).codigo).toBe("42501");
    expect(BuzonRepoError.desde({ code: "P0001" }).codigo).toBe("P0001");
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["una cadena", "boom"],
    ["un número", 42],
    ["un objeto sin code", { message: "x" }],
    ["code numérico", { code: 23503 }],
    ["code de largo incorrecto", { code: "2350" }],
    ["code demasiado largo", { code: "235033" }],
    ["code en minúsculas", { code: "p0001" }],
    ["code con símbolos", { code: "23-03" }],
    ["code con texto libre", { code: "ECONNREFUSED" }],
  ])("%s da «desconocido»", (_n, error) => {
    const e = BuzonRepoError.desde(error);
    expect(e.codigo).toBe("desconocido");
    expect(e.message).toBe(
      "Error de base de datos en buzón (SQLSTATE desconocido)",
    );
  });

  it("un Error real de Node con code de red también es «desconocido»", () => {
    const err = Object.assign(new Error("connect ECONNREFUSED 10.0.0.1"), {
      code: "ECONNREFUSED",
    });
    expect(BuzonRepoError.desde(err).codigo).toBe("desconocido");
  });
});

describe("consultar", () => {
  it("devuelve filas y rowCount de la consulta, con los valores parametrizados", async () => {
    const llamadas: unknown[][] = [];
    const tx = {
      query: async (texto: string, valores: unknown[]) => {
        llamadas.push([texto, valores]);
        return { rows: [{ id: 1 }, { id: 2 }], rowCount: 2 };
      },
    } as unknown as TxConsulta;
    const r = await consultar(tx, "select $1", ["a"]);
    expect(r).toEqual({ rows: [{ id: 1 }, { id: 2 }], rowCount: 2 });
    expect(llamadas).toEqual([["select $1", ["a"]]]);
  });

  it("rowCount nulo se vuelve 0", async () => {
    const tx = {
      query: async () => ({ rows: [], rowCount: null }),
    } as unknown as TxConsulta;
    expect(await consultar(tx, "select 1", [])).toEqual({
      rows: [],
      rowCount: 0,
    });
  });

  it("cualquier fallo sale como BuzonRepoError con solo el SQLSTATE", async () => {
    const tx = {
      query: async () => {
        throw Object.assign(new Error("detalle con CLAVE-SOL"), {
          code: "42501",
          detail: "CLAVE-SOL",
        });
      },
    } as unknown as TxConsulta;
    const e = await consultar(tx, "select 1", []).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BuzonRepoError);
    expect((e as BuzonRepoError).codigo).toBe("42501");
    expect((e as BuzonRepoError).message).not.toContain("CLAVE-SOL");
  });

  it("un fallo sin SQLSTATE sale como «desconocido»", async () => {
    const tx = {
      query: async () => {
        throw new Error("socket cerrado");
      },
    } as unknown as TxConsulta;
    const e = await consultar(tx, "select 1", []).catch((x: unknown) => x);
    expect((e as BuzonRepoError).codigo).toBe("desconocido");
  });
});

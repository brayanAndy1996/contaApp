// Spec 013: VentasRepoError conserva solo el SQLSTATE (mismo patrón que TrabajosRepoError).
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { VentasRepoError } from "./errores";

describe("VentasRepoError.desde", () => {
  it("conserva solo el SQLSTATE de un error de pg, sin detail, constraint ni cause", () => {
    const origen = Object.assign(new Error("fila con CANARIO-SECRETO"), {
      code: "23505",
      detail: "CANARIO-SECRETO",
      constraint: "venta_cliente_periodo_clave_unique",
    });
    const e = VentasRepoError.desde(origen);
    expect(e).toBeInstanceOf(VentasRepoError);
    expect(e.codigo).toBe("23505");
    for (const k of ["detail", "constraint", "table", "column", "where"]) expect(e).not.toHaveProperty(k);
    expect(e.cause).toBeUndefined();
    expect(inspect(e) + JSON.stringify(e) + e.message + String(e.stack)).not.toContain("CANARIO-SECRETO");
    expect(e.message).toContain("23505");
  });

  it("el constructor directo guarda el código y el nombre", () => {
    const e = new VentasRepoError("40001");
    expect(e.codigo).toBe("40001");
    expect(e.name).toBe("VentasRepoError");
  });

  it.each([
    ["sin code", new Error("ECONNRESET")],
    ["code que no es SQLSTATE", { code: "ECONNREFUSED" }],
    ["code en minúsculas", { code: "42p01" }],
    ["code numérico", { code: 42501 }],
    ["valor no objeto", "texto"],
    ["undefined", undefined],
    ["null", null],
  ])("%s -> codigo 'desconocido'", (_n, error) => {
    expect(VentasRepoError.desde(error).codigo).toBe("desconocido");
  });
});

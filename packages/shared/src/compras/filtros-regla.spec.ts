import { describe, expect, it } from "vitest";
import { CODIGOS_REGLA, listarComprasSchema } from "../index.js";

// Spec 025 · T12: el filtro `regla` del listado de compras (la grilla filtra por R-STD).
describe("listarComprasSchema · filtro regla (025)", () => {
  it.each(CODIGOS_REGLA)("acepta %s", (regla) => {
    expect(listarComprasSchema.parse({ regla }).regla).toBe(regla);
  });
  it("es opcional y se combina con los demás filtros", () => {
    expect(listarComprasSchema.parse({}).regla).toBeUndefined();
    expect(listarComprasSchema.parse({ regla: "R-STD", alertas: "true", limite: "50" })).toEqual({ regla: "R-STD", alertas: true, limite: 50 });
  });
  it.each(["R-HIS", "r-std", "", "R-STD,R-NEW", 5, null, true])("rechaza %j", (regla) => {
    expect(listarComprasSchema.safeParse({ regla }).success).toBe(false);
  });
});

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { respuestaDescartarSchema } from "../index.js";

// Spec 025 · T12: respuesta de descartar candidatas `{descartadas, omitidas}`, ambas listas de ids.
describe("respuestaDescartarSchema (025)", () => {
  it("acepta listas de uuid, también vacías", () => {
    const [a, b] = [randomUUID(), randomUUID()];
    expect(respuestaDescartarSchema.parse({ descartadas: [a], omitidas: [b] })).toEqual({ descartadas: [a], omitidas: [b] });
    expect(respuestaDescartarSchema.parse({ descartadas: [], omitidas: [] })).toEqual({ descartadas: [], omitidas: [] });
  });
  it.each([
    [{ descartadas: ["x"], omitidas: [] }],
    [{ descartadas: [] }],
    [{ omitidas: [] }],
    [{ descartadas: [], omitidas: [{ id: randomUUID() }] }],
    [null],
  ])("rechaza %j", (v) => {
    expect(respuestaDescartarSchema.safeParse(v).success).toBe(false);
  });
});

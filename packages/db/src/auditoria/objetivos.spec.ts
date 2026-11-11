// Spec 017 (T18a-servidor, P-4): `resolverUsuariosDeEntidades` con una `tx` falsa. Sin ids no consulta; los ids viajan como
// parámetro y sin repetir; nunca pide el correo de la invitación (D-5).
import { describe, expect, it } from "vitest";
import { resolverUsuariosDeEntidades } from "./objetivos";

const M = "0190a000-0000-7000-8000-0000000000a1";
const I = "0190a000-0000-7000-8000-0000000000a2";
const U = "0190a000-0000-7000-8000-0000000000b1";

function txCon(respuestas: Record<string, Record<string, unknown>[]>) {
  const consultas: { texto: string; valores: unknown[] }[] = [];
  return {
    consultas,
    query: async (texto: string, valores: unknown[]) => {
      consultas.push({ texto, valores });
      return { rows: respuestas[texto.includes("from membresia") ? "m" : "i"] ?? [] };
    },
  };
}

describe("resolverUsuariosDeEntidades", () => {
  it("sin ids no consulta y devuelve mapas vacíos", async () => {
    const tx = txCon({});
    const r = await resolverUsuariosDeEntidades(tx as never, { membresias: [], invitaciones: [] });
    expect(tx.consultas).toHaveLength(0);
    expect(r.membresias.size + r.invitaciones.size).toBe(0);
  });

  it("une membresía -> usuario e invitación -> quien la aceptó, con ids únicos como parámetro", async () => {
    const tx = txCon({ m: [{ id: M, usuario_id: U }], i: [{ id: I, aceptada_por: U }] });
    const r = await resolverUsuariosDeEntidades(tx as never, { membresias: [M, M], invitaciones: [I, I] });
    expect(r.membresias.get(M)).toBe(U);
    expect(r.invitaciones.get(I)).toBe(U);
    expect(tx.consultas.map((c) => c.valores)).toEqual([[[M]], [[I]]]);
  });

  it("no consulta el correo de la invitación", async () => {
    const tx = txCon({});
    await resolverUsuariosDeEntidades(tx as never, { membresias: [], invitaciones: [I] });
    expect(tx.consultas[0]!.texto).not.toMatch(/correo|email|token/i);
  });
});

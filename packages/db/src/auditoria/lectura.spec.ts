// Spec 017 (T14a, P-2, D-6): `listarAuditoria` con una `tx` falsa. El límite siempre se recorta a 1..50 aunque llegue basura
// (NaN, infinito, negativo, decimal), y el cursor viaja como parámetros, nunca en el texto de la consulta.
import { describe, expect, it } from "vitest";
import { listarAuditoria, MAX_PAGINA_AUDITORIA } from "./lectura";

const ID = "0190a000-0000-7000-8000-0000000000a1";

function txCon(rows: Record<string, unknown>[] = []) {
  const consultas: { texto: string; valores: unknown[] }[] = [];
  return {
    consultas,
    query: async (texto: string, valores: unknown[]) => {
      consultas.push({ texto, valores });
      return { rows };
    },
  };
}

describe("listarAuditoria: límite", () => {
  it.each([
    ["omitido", undefined, 50],
    ["NaN", Number.NaN, 50],
    ["infinito", Number.POSITIVE_INFINITY, 50],
    ["menos infinito", Number.NEGATIVE_INFINITY, 50],
    ["cero", 0, 1],
    ["negativo", -7, 1],
    ["decimal", 12.9, 12],
    ["justo el máximo", 50, 50],
    ["mayor que el máximo", 5000, 50],
  ])("límite %s se recorta a %i", async (_n, limite, esperado) => {
    const tx = txCon();
    await listarAuditoria(tx as never, limite === undefined ? {} : { limite });
    expect(tx.consultas[0]!.valores[2]).toBe(esperado);
    expect(MAX_PAGINA_AUDITORIA).toBe(50);
  });

  it("sin opciones pide la primera página de 50", async () => {
    const tx = txCon();
    await listarAuditoria(tx as never);
    expect(tx.consultas[0]!.valores).toEqual([null, null, 50]);
  });
});

describe("listarAuditoria: cursor y mapeo", () => {
  it("el cursor va como parámetros, no en el texto", async () => {
    const tx = txCon();
    const en = new Date("2026-10-05T12:00:00.123Z");
    await listarAuditoria(tx as never, { antes: { en, id: ID }, limite: 10 });
    expect(tx.consultas[0]!.valores).toEqual([en, ID, 10]);
    expect(tx.consultas[0]!.texto).not.toContain(ID);
  });

  it("pasa de columnas a camelCase y conserva los nulos", async () => {
    const ocurrida = new Date("2026-10-05T12:00:00.123Z");
    const tx = txCon([
      {
        id: ID,
        ocurrida_en: ocurrida,
        accion: "credencial.descifrada",
        actor_tipo: "sistema",
        usuario_id: null,
        trabajo_id: null,
        cliente_id: null,
        entidad: "auditoria_descifrado",
        entidad_id: ID,
        datos: { tipo: "sol" },
      },
    ]);
    expect(await listarAuditoria(tx as never)).toEqual([
      {
        id: ID,
        ocurridaEn: ocurrida,
        accion: "credencial.descifrada",
        actorTipo: "sistema",
        usuarioId: null,
        trabajoId: null,
        clienteId: null,
        entidad: "auditoria_descifrado",
        entidadId: ID,
        datos: { tipo: "sol" },
      },
    ]);
  });
});

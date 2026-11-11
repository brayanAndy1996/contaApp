// Spec 017 (T14a, D-8, D-9): la escritura de notificaciones con una `tx` falsa (sin BD). Cubre lo que la BD real no alcanza: la
// respuesta sin filas o con `n` nulo, `marcarLeida` con y sin alcance, y que un error de pg sale solo como SQLSTATE.
import { describe, expect, it } from "vitest";
import { AccesoRepoError } from "../acceso/errores";
import {
  destinatariosNuevos,
  marcarLeida,
  marcarLeidasHasta,
  purgarNotificaciones,
} from "./escritura";

const ID = "0190a000-0000-7000-8000-0000000000e1";
const U1 = "0190a000-0000-7000-8000-0000000000b1";
const U2 = "0190a000-0000-7000-8000-0000000000b2";

type Respuesta = { rows: Record<string, unknown>[] };
/** `tx` falsa: responde en orden y recuerda cada consulta (texto y valores). */
function txCon(...respuestas: Respuesta[]) {
  const consultas: { texto: string; valores: unknown[] }[] = [];
  const cola = [...respuestas];
  return {
    consultas,
    query: async (texto: string, valores: unknown[]) => {
      consultas.push({ texto, valores });
      return cola.shift() ?? { rows: [] };
    },
  };
}

describe("marcarLeida", () => {
  it("sin alcance (alcance omitido) marca la propia y no hace la segunda consulta", async () => {
    const tx = txCon({ rows: [{ id: ID }] });
    expect(await marcarLeida(tx as never, ID)).toBe(true);
    expect(tx.consultas).toHaveLength(1);
    expect(tx.consultas[0]!.texto).toContain("update notificacion");
    expect(tx.consultas[0]!.texto).toContain("app.user_id");
    expect(tx.consultas[0]!.texto).not.toContain("cliente_id is null");
    expect(tx.consultas[0]!.valores).toEqual([ID]);
  });

  it("con alcance filtra por los clientes visibles, también al comprobar si ya estaba leída", async () => {
    const tx = txCon({ rows: [] }, { rows: [{ ok: 1 }] });
    expect(await marcarLeida(tx as never, ID, { tipo: "global" })).toBe(true);
    expect(tx.consultas).toHaveLength(2);
    for (const c of tx.consultas) expect(c.texto).toContain("n.cliente_id is null");
    expect(tx.consultas[1]!.texto).not.toContain("update");
  });

  it("ajena, inexistente o de un cliente no visible: false y solo lee", async () => {
    const tx = txCon({ rows: [] }, { rows: [] });
    expect(await marcarLeida(tx as never, ID, { tipo: "asignado", usuarioId: U1 })).toBe(false);
    expect(tx.consultas).toHaveLength(2);
  });

  it("un error de pg sale como AccesoRepoError con solo el SQLSTATE", async () => {
    const tx = { query: async () => { throw Object.assign(new Error("CANARIO"), { code: "42501", detail: "CANARIO" }); } };
    const e = await marcarLeida(tx as never, ID).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AccesoRepoError);
    expect((e as AccesoRepoError).codigo).toBe("42501");
    expect(JSON.stringify(e) + (e as Error).message).not.toContain("CANARIO");
  });
});

describe("marcarLeidasHasta", () => {
  const HASTA = new Date("2026-10-05T12:00:00.123Z");

  it("devuelve el conteo como número y pasa el instante", async () => {
    const tx = txCon({ rows: [{ n: "4" }] });
    expect(await marcarLeidasHasta(tx as never, { tipo: "global" }, HASTA)).toBe(4);
    expect(tx.consultas[0]!.valores).toContain(HASTA);
  });

  it.each([
    ["sin filas", { rows: [] }],
    ["con n nulo", { rows: [{ n: null }] }],
    ["con n ausente", { rows: [{}] }],
  ])("una respuesta %s cuenta cero", async (_n, r) => {
    expect(await marcarLeidasHasta(txCon(r) as never, { tipo: "global" }, HASTA)).toBe(0);
  });
});

describe("destinatariosNuevos", () => {
  it("devuelve los usuarios sin repetir y conserva el orden de aparición", async () => {
    const tx = txCon({ rows: [{ usuario_id: U2 }, { usuario_id: U1 }, { usuario_id: U2 }] });
    expect(await destinatariosNuevos(tx as never)).toEqual([U2, U1]);
    expect(tx.consultas[0]!.texto).toContain("notificaciones_de_esta_transaccion()");
  });

  it("sin notificaciones nuevas devuelve una lista vacía", async () => {
    expect(await destinatariosNuevos(txCon({ rows: [] }) as never)).toEqual([]);
  });
});

describe("purgarNotificaciones", () => {
  it("llama a la función SQL con los días y devuelve cuántas borró", async () => {
    const tx = txCon({ rows: [{ n: 7 }] });
    expect(await purgarNotificaciones(tx as never, 90)).toBe(7);
    expect(tx.consultas[0]).toEqual({ texto: "select notificacion_purgar($1::int) as n", valores: [90] });
  });

  it.each([
    ["sin filas", { rows: [] }],
    ["con n nulo", { rows: [{ n: null }] }],
  ])("una respuesta %s cuenta cero", async (_n, r) => {
    expect(await purgarNotificaciones(txCon(r) as never, 30)).toBe(0);
  });
});

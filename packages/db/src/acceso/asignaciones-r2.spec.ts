// Spec 005 · T17 (H-005-2a-1, H-005-2b-1, H-005-2b-3): orden global de bloqueo y normalización de los lotes, sin
// BD (tx espía que responde según el SQL). Las carreras reales están en los `*-r2*.adv.int.spec.ts` y en
// apps/backend/src/modules/clientes/asignaciones-r2.int.spec.ts.
import { describe, expect, it } from "vitest";
import { asignarPorCliente, asignarPorUsuario } from "./asignaciones";
import { AccesoReglaError } from "./errores";
import { bloquearMiembros } from "./miembros";

const U1 = "01920000-0000-7000-8000-00000000a0a1";
const U2 = "01920000-0000-7000-8000-00000000b0b2";
const C1 = "01920000-0000-7000-8000-00000000c0c1";
type TxFalsa = Parameters<typeof bloquearMiembros>[0];

/** Responde a cada SQL con las filas de `respuestas` (por fragmento) y registra el orden. */
function txEspia(respuestas: Array<[RegExp, (valores: unknown[]) => unknown[]]>) {
  const llamadas: Array<{ texto: string; valores: unknown[] }> = [];
  const tx = {
    query: async (texto: string, valores: unknown[] = []) => {
      llamadas.push({ texto, valores });
      const r = respuestas.find(([re]) => re.test(texto));
      const rows = r === undefined ? [] : r[1](valores);
      return { rows, rowCount: rows.length };
    },
  } as unknown as TxFalsa;
  return { tx, llamadas };
}

const todos = (activo = true) =>
  [
    [/from membresia/, (v: unknown[]) => (v[0] as string[]).map((usuario_id) => ({ usuario_id, activo }))],
    [/from cliente/, (v: unknown[]) => (v[0] as string[]).map((id) => ({ id }))],
  ] as Array<[RegExp, (valores: unknown[]) => unknown[]]>;

describe("bloquearMiembros", () => {
  it("una sola sentencia ORDER BY usuario_id FOR UPDATE con los IDs en minúsculas y sin repetir; Map por ID", async () => {
    const { tx, llamadas } = txEspia([
      [/from membresia/, () => [{ usuario_id: U1, rol: "admin", activo: true }, { usuario_id: U2, rol: "lectura", activo: false }]],
    ]);
    const m = await bloquearMiembros(tx, [U2.toUpperCase(), U1, U2]);
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]!.texto).toMatch(/order by usuario_id for update/);
    expect(llamadas[0]!.valores).toEqual([[U2, U1]]);
    expect(m.get(U1)).toEqual({ usuarioId: U1, rol: "admin", activo: true });
    expect(m.get(U2)).toEqual({ usuarioId: U2, rol: "lectura", activo: false });
  });

  it("quien no es del estudio no está en el Map", async () => {
    const { tx } = txEspia([]);
    expect((await bloquearMiembros(tx, [U1])).has(U1)).toBe(false);
  });
});

describe("lotes: membresías antes que clientes; IDs normalizados antes de contar", () => {
  it("por-cliente: el mismo UUID en dos grafías cuenta una vez y se bloquea miembros -> cliente -> inserta", async () => {
    const { tx, llamadas } = txEspia(todos());
    expect(await asignarPorCliente(tx, { clienteId: C1, usuarioIds: [U1, U1.toUpperCase()] })).toEqual({ asignados: 1 });
    expect(llamadas.map((l) => /from membresia|from cliente|insert into/.exec(l.texto)?.[0])).toEqual([
      "from membresia",
      "from cliente",
      "insert into",
    ]);
    expect(llamadas[0]!.valores).toEqual([[U1]]);
  });

  it("por-usuario: clientes en dos grafías cuentan una vez; miembros antes que clientes", async () => {
    const { tx, llamadas } = txEspia(todos());
    const r = await asignarPorUsuario(tx, { usuarioId: U1, clienteIds: [C1.toUpperCase(), C1], tipo: "colaborador" });
    expect(r).toEqual({ asignados: 1 });
    expect(llamadas[0]!.texto).toMatch(/from membresia/);
    expect(llamadas[1]!.texto).toMatch(/from cliente/);
    expect(llamadas[1]!.valores).toEqual([[C1]]);
  });

  it("error: un cliente ajeno sigue dando null (404) aunque el miembro esté desactivado (precedencia de antes)", async () => {
    const { tx, llamadas } = txEspia([
      [/from membresia/, (v) => (v[0] as string[]).map((usuario_id) => ({ usuario_id, activo: false }))],
      [/from cliente/, () => []],
    ]);
    expect(await asignarPorCliente(tx, { clienteId: C1, usuarioIds: [U1] })).toBeNull();
    expect(llamadas.some((l) => /insert into/.test(l.texto))).toBe(false);
  });

  it("error: miembro desactivado con cliente válido -> miembro_no_asignable sin escribir", async () => {
    const { tx, llamadas } = txEspia(todos(false));
    await expect(asignarPorCliente(tx, { clienteId: C1, usuarioIds: [U1] })).rejects.toBeInstanceOf(AccesoReglaError);
    expect(llamadas.some((l) => /insert into/.test(l.texto))).toBe(false);
  });
});

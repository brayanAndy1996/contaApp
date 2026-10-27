// Spec 005 · T15 (H-005-1b-1): `revocarPendientesDe` sin BD (tx falsa). El comportamiento real (RLS, estudios,
// vencidas, aceptadas) está en tests/aislamiento/acceso-correcciones-r1.spec.ts.
import { describe, expect, it } from "vitest";
import { AccesoRepoError } from "./errores";
import { revocarPendientesDe } from "./invitaciones";

const U1 = "01920000-0000-7000-8000-00000000c0a1";
type TxFalsa = Parameters<typeof revocarPendientesDe>[0];

function txEspia(rows: unknown[]) {
  const llamadas: Array<{ texto: string; valores: unknown[] }> = [];
  const tx = {
    query: async (texto: string, valores: unknown[] = []) => {
      llamadas.push({ texto, valores });
      return { rows, rowCount: rows.length };
    },
  } as unknown as TxFalsa;
  return { tx, llamadas };
}

describe("revocarPendientesDe", () => {
  it("SQL estático: usuario y roles que conserva viajan como parámetros; devuelve cuántas revocó", async () => {
    const { tx, llamadas } = txEspia([{ id: "a" }, { id: "b" }]);
    const roles = ["admin", "lectura"] as const;
    expect(await revocarPendientesDe(tx, U1, roles)).toBe(2);
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]!.valores).toEqual([U1, ["admin", "lectura"]]);
    expect(llamadas[0]!.valores[1]).not.toBe(roles); // copia, no el arreglo del llamador
    expect(llamadas[0]!.texto).not.toContain(U1);
    expect(llamadas[0]!.texto).toMatch(/aceptada_en is null and revocada_en is null/);
  });

  it("un error de pg sale como AccesoRepoError solo con el SQLSTATE", async () => {
    const tx = {
      query: async () => {
        throw Object.assign(new Error("detalle CANARIO-R1"), { code: "42501", detail: "CANARIO-R1" });
      },
    } as unknown as TxFalsa;
    const e = (await revocarPendientesDe(tx, U1, []).catch((x: unknown) => x)) as AccesoRepoError;
    expect(e).toBeInstanceOf(AccesoRepoError);
    expect(e.codigo).toBe("42501");
    expect(JSON.stringify(e) + e.message).not.toContain("CANARIO-R1");
  });
});

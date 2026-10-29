// T15 · F3: el CAS de reemplazarDekEnvuelta compara también kek_id.
// Ajuste de 008 (T3, CA-12, nota [008]): `kekAnterior` es OBLIGATORIO (tipo y tiempo de ejecución): sin él la
// función lanza antes de consultar (falla cerrado). Antes era opcional y, ausente, el CAS comparaba solo la DEK.
// Sin BD (tx falso); el comportamiento con BD real está en tests/aislamiento y en el worker.
import { describe, expect, it } from "vitest";
import { reemplazarDekEnvuelta, type TxConsulta } from "./repositorio";

function txFalso(rowCount: number) {
  const llamadas: Array<{ texto: string; valores: unknown[] }> = [];
  const tx = {
    query: async (texto: string, valores: unknown[]) => {
      llamadas.push({ texto, valores });
      return { rows: [], rowCount };
    },
  } as unknown as TxConsulta;
  return { tx, llamadas };
}

const base = {
  id: "00000000-0000-4000-8000-000000000001",
  dekAnterior: Buffer.alloc(512, 1),
  dekNueva: Buffer.alloc(512, 2),
  kekNuevo: "k2",
};

describe("reemplazarDekEnvuelta: CAS con kek_id", () => {
  it("con kekAnterior lo pasa al CAS (kek_id = $5) y devuelve true si cambió la fila", async () => {
    const { tx, llamadas } = txFalso(1);
    expect(await reemplazarDekEnvuelta(tx, { ...base, kekAnterior: "k1" })).toBe(true);
    expect(llamadas[0]!.texto).toMatch(/kek_id = \$5/);
    expect(llamadas[0]!.valores[4]).toBe("k1");
  });

  it("si el CAS no encuentra la fila (kek_id cambió) devuelve false", async () => {
    const { tx, llamadas } = txFalso(0);
    expect(await reemplazarDekEnvuelta(tx, { ...base, kekAnterior: "k1" })).toBe(false);
    expect(llamadas[0]!.valores[4]).toBe("k1");
  });
});

describe("reemplazarDekEnvuelta: kekAnterior obligatorio (008, CA-12)", () => {
  it("el tipo lo exige: sin kekAnterior no compila", () => {
    const { tx } = txFalso(1);
    // @ts-expect-error 008: kekAnterior es obligatorio (antes era opcional)
    const sinKek = () => reemplazarDekEnvuelta(tx, base);
    expect(typeof sinKek).toBe("function"); // no se ejecuta: solo se comprueba el error de tipos
  });

  it.each([
    ["ausente", {}],
    ["undefined", { kekAnterior: undefined }],
    ["null", { kekAnterior: null }],
    ["cadena vacía", { kekAnterior: "" }],
  ])("en tiempo de ejecución, kekAnterior %s lanza ANTES de consultar", async (_n, extra) => {
    const { tx, llamadas } = txFalso(1);
    await expect(
      reemplazarDekEnvuelta(tx, { ...base, ...extra } as unknown as Parameters<typeof reemplazarDekEnvuelta>[1]),
    ).rejects.toThrow();
    expect(llamadas).toHaveLength(0);
  });
});

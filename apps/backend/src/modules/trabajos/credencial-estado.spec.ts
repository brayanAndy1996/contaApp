// Spec 007b (T12) · `leerEstadoCredenciales` (packages/db): proyección de las columnas de estado y envoltura de errores.
// Sin BD: `tx` falso. La lectura real con RLS la cubren `credenciales.int.spec.ts` y las pruebas de aislamiento.
import { CredencialRepoError, leerEstadoCredenciales } from "@contapp/db";
import { describe, expect, it, vi } from "vitest";

const CLIENTE = "0190a000-0000-7000-8000-0000000000c1";

describe("leerEstadoCredenciales", () => {
  it("devuelve tipo, estado, fecha y motivo de cada fila; fecha y motivo ausentes salen null; consulta solo columnas de estado", async () => {
    const fecha = new Date("2026-11-04T10:00:00Z");
    const query = vi.fn<(texto: string, valores: unknown[]) => Promise<{ rows: unknown[] }>>(async () => ({
      rows: [
        { tipo: "sire_api", estado: "invalida", estado_at: fecha, estado_motivo: "credencial_invalida" },
        { tipo: "sol", estado: "configurada", estado_at: null, estado_motivo: null },
      ],
    }));
    const r = await leerEstadoCredenciales({ query } as never, CLIENTE);
    expect(r).toEqual([
      { tipo: "sire_api", estado: "invalida", fecha, motivo: "credencial_invalida" },
      { tipo: "sol", estado: "configurada", fecha: null, motivo: null },
    ]);
    expect(query).toHaveBeenCalledWith(expect.stringMatching(/select tipo, estado, estado_at, estado_motivo from credencial/), [CLIENTE]);
    expect(String(query.mock.calls[0]?.[0])).not.toMatch(/ciphertext|nonce|dek_envuelta|tag/);
  });

  it("un fallo de la BD se envuelve en CredencialRepoError, sin propagar el error original", async () => {
    const query = vi.fn(async () => {
      throw Object.assign(new Error("detalle interno"), { code: "42501" });
    });
    await expect(leerEstadoCredenciales({ query } as never, CLIENTE)).rejects.toBeInstanceOf(CredencialRepoError);
  });
});

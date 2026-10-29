// Spec 008 (T3, rojo): estado de la credencial (D13, CA-9) sin BD. El comportamiento con BD real esta en
// tests/aislamiento/trabajos-repos.spec.ts. estadoCredencial devuelve solo el estado (forma que usa packages/queue, T4).
import { describe, expect, it } from "vitest";
import { estadoCredencial, marcarCredencialInvalida } from "./estado";
import { errorPg, txFalso } from "../trabajos/soporte-prueba";

const CLI = "00000000-0000-4000-8000-0000000000c1";

describe("marcarCredencialInvalida", () => {
  it.each([
    [1, true],
    [0, false],
    [null, false],
  ])(
    "rowCount %s -> %s (true solo si la credencial existia y no estaba ya invalida)",
    async (rowCount, esperado) => {
      const { tx } = txFalso({ rowCount });
      expect(
        await marcarCredencialInvalida(tx, CLI, "sol", "credencial_invalida"),
      ).toBe(esperado);
    },
  );

  it("cliente, tipo y motivo viajan como parametros; solo cambia las 3 columnas de estado y no repite una ya invalida", async () => {
    const { tx, llamadas } = txFalso({ rowCount: 1 });
    await marcarCredencialInvalida(tx, CLI, "sire_api", "credencial_invalida");
    const { texto, valores } = llamadas[0]!;
    expect(valores).toEqual(
      expect.arrayContaining([CLI, "sire_api", "credencial_invalida"]),
    );
    expect(texto).toMatch(/update credencial/i);
    expect(texto).toMatch(/estado\s*=/);
    expect(texto).toMatch(/estado_motivo\s*=/);
    expect(texto).toMatch(/estado_at\s*=/);
    expect(texto).toMatch(/invalida/);
    const set = texto.split(/\bwhere\b/i)[0]!;
    for (const prohibida of [
      "ciphertext",
      "nonce",
      "tag",
      "dek_envuelta",
      "kek_id",
      "version",
    ])
      expect(set, prohibida).not.toContain(prohibida);
    expect(texto).not.toContain(CLI);
  });

  it("un error de pg sale con codigo SQLSTATE y sin datos del error original", async () => {
    const e = await marcarCredencialInvalida(
      txFalso(errorPg("42501")).tx,
      CLI,
      "sol",
      "credencial_invalida",
    ).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect((e as { codigo: string }).codigo).toBe("42501");
    expect(JSON.stringify(e) + String((e as Error).message)).not.toContain(
      "CANARIO-SOL-123",
    );
    expect(e).not.toHaveProperty("detail");
  });
});

describe("estadoCredencial", () => {
  it.each(["configurada", "verificada", "invalida"])(
    "devuelve el estado '%s' como texto",
    async (estado) => {
      const { tx, llamadas } = txFalso({ rows: [{ estado }] });
      expect(await estadoCredencial(tx, CLI, "sol")).toBe(estado);
      expect(llamadas[0]!.valores).toEqual(
        expect.arrayContaining([CLI, "sol"]),
      );
    },
  );

  it("sin credencial devuelve null", async () => {
    expect(
      await estadoCredencial(txFalso({ rows: [] }).tx, CLI, "sire_api"),
    ).toBeNull();
  });

  it("lee solo columnas de estado (el backend no tiene SELECT del sobre)", async () => {
    const { tx, llamadas } = txFalso({ rows: [{ estado: "configurada" }] });
    await estadoCredencial(tx, CLI, "sol");
    const texto = llamadas[0]!.texto;
    for (const sensible of [
      "ciphertext",
      "nonce",
      "dek_envuelta",
      "select *",
      "returning *",
    ])
      expect(texto.toLowerCase()).not.toContain(sensible);
    expect(texto).not.toMatch(/\btag\b/);
  });

  it("un error de pg sale con codigo SQLSTATE", async () => {
    const e = await estadoCredencial(
      txFalso(errorPg("42501")).tx,
      CLI,
      "sol",
    ).catch((x: unknown) => x);
    expect((e as { codigo: string }).codigo).toBe("42501");
  });
});

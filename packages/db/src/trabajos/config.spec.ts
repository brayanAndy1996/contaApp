// Spec 008 (T3, rojo): lectura de config_sistema (CA-4, D12) sin BD. leerConfig se llama dentro de withSistema.
// Forma alineada con packages/queue/src/soporte-pruebas/bd-falsa.ts (T4): Map<cola, ConfigCola> en camelCase.
import { describe, expect, it } from "vitest";
import { leerConfig } from "./config";
import { TrabajosRepoError } from "./errores";
import { errorPg, txFalso } from "./soporte-prueba";

const fila = (cola: string, o: Record<string, unknown> = {}) => ({
  cola,
  concurrencia_global: 4,
  concurrencia_tenant: 2,
  espera_ruc_ms: 2000,
  reintentos: 3,
  backoff_base_ms: 5000,
  max_pendientes_tenant: 2000,
  actualizado_en: new Date("2026-10-27T00:00:00Z"),
  ...o,
});

describe("leerConfig", () => {
  it("devuelve un Map por cola con los limites en camelCase y como numeros", async () => {
    const { tx, llamadas } = txFalso({
      rows: [
        fila("sire"),
        fila("sol", { concurrencia_global: 2, concurrencia_tenant: 1 }),
      ],
    });
    const m = await leerConfig(tx);
    expect(m).toBeInstanceOf(Map);
    expect([...m.keys()].sort()).toEqual(["sire", "sol"]);
    expect(m.get("sire")).toMatchObject({
      concurrenciaGlobal: 4,
      concurrenciaTenant: 2,
      esperaRucMs: 2000,
      reintentos: 3,
      backoffBaseMs: 5000,
      maxPendientesTenant: 2000,
    });
    expect(m.get("sol")).toMatchObject({
      concurrenciaGlobal: 2,
      concurrenciaTenant: 1,
    });
    expect(llamadas[0]!.texto).toMatch(/config_sistema/);
  });

  it("convierte a number los valores que pg entrega como string y no inventa colas", async () => {
    const { tx } = txFalso({
      rows: [fila("xml", { espera_ruc_ms: "600000", backoff_base_ms: "100" })],
    });
    const m = await leerConfig(tx);
    expect(m.get("xml")).toMatchObject({
      esperaRucMs: 600000,
      backoffBaseMs: 100,
    });
    expect(m.get("sire")).toBeUndefined();
    expect(m.size).toBe(1);
  });

  it("sin filas devuelve un Map vacio (el despachador conserva la ultima configuracion valida)", async () => {
    expect((await leerConfig(txFalso({ rows: [] }).tx)).size).toBe(0);
  });

  it("un error de pg sale como TrabajosRepoError con el SQLSTATE (el despachador conserva la anterior)", async () => {
    const e = await leerConfig(txFalso(errorPg("57P01")).tx).catch(
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(TrabajosRepoError);
    expect((e as TrabajosRepoError).codigo).toBe("57P01");
  });
});

// Spec 023 (T4, rojo): repos del candado del ciclo del programador (sistema.buzon_ciclo_* y sistema.estudios_buzon, 0055) sin BD.
// Se llaman con la `tx` de withSistema (contapp_worker sin estudio). Contrato: ver tests/aislamiento/buzon-soporte.ts.
import { describe, expect, it } from "vitest";
import { TrabajosRepoError } from "../trabajos/errores";
import {
  estudiosBuzon,
  renovarCiclo,
  soltarCiclo,
  tomarCiclo,
} from "../trabajos/sistema";
import { errorPg, txFalso } from "../trabajos/soporte-prueba";

const T1 = "0190a000-0000-7000-8000-0000000000a1";
const T2 = "0190a000-0000-7000-8000-0000000000a2";

describe("estudiosBuzon", () => {
  it("llama a sistema.estudios_buzon() y devuelve solo tenantId y frecuenciaMin (entero)", async () => {
    const { tx, llamadas } = txFalso({
      rows: [
        { tenant_id: T1, frecuencia_min: 720 },
        { tenant_id: T2, frecuencia_min: "60" },
      ],
    });
    expect(await estudiosBuzon(tx)).toEqual([
      { tenantId: T1, frecuenciaMin: 720 },
      { tenantId: T2, frecuenciaMin: 60 },
    ]);
    expect(llamadas[0]!.texto).toMatch(/sistema\.estudios_buzon\(\)/);
  });

  it("sin estudios vigentes devuelve []", async () => {
    expect(await estudiosBuzon(txFalso({ rows: [] }).tx)).toEqual([]);
  });
});

describe("tomarCiclo", () => {
  it("pasa el dueño como $1::text y devuelve la hora de la BD y la configuracion", async () => {
    const ahora = new Date("2026-11-17T08:00:00Z");
    const { tx, llamadas } = txFalso({
      rows: [
        {
          ahora,
          intervalo_min: 15,
          reserva_interactiva: "50",
          lote_estudio: 1000,
        },
      ],
    });
    expect(await tomarCiclo(tx, "proceso-1")).toEqual({
      ahora,
      intervaloMin: 15,
      reservaInteractiva: 50,
      loteEstudio: 1000,
    });
    expect(llamadas[0]!.texto).toMatch(
      /sistema\.buzon_ciclo_tomar\(\$1::text\)/,
    );
    expect(llamadas[0]!.valores).toEqual(["proceso-1"]);
  });

  it("sin fila (otro worker lo tiene o no toca aun) devuelve null", async () => {
    expect(await tomarCiclo(txFalso({ rows: [] }).tx, "proceso-1")).toBeNull();
  });
});

describe("renovarCiclo", () => {
  it("true si la funcion devuelve true (sea cual sea el nombre de la columna) y false en cualquier otro caso", async () => {
    const dueno = txFalso({ rows: [{ buzon_ciclo_renovar: true }] });
    expect(await renovarCiclo(dueno.tx, "proceso-1")).toBe(true);
    expect(dueno.llamadas[0]!.texto).toMatch(
      /sistema\.buzon_ciclo_renovar\(\$1::text\)/,
    );
    expect(dueno.llamadas[0]!.valores).toEqual(["proceso-1"]);
    expect(
      await renovarCiclo(txFalso({ rows: [{ x: false }] }).tx, "proceso-1"),
    ).toBe(false);
    expect(await renovarCiclo(txFalso({ rows: [] }).tx, "proceso-1")).toBe(
      false,
    );
  });
});

describe("soltarCiclo", () => {
  it("llama a sistema.buzon_ciclo_soltar con el dueño y no devuelve nada", async () => {
    const { tx, llamadas } = txFalso({ rows: [{ buzon_ciclo_soltar: null }] });
    expect(await soltarCiclo(tx, "proceso-1")).toBeUndefined();
    expect(llamadas[0]!.texto).toMatch(
      /sistema\.buzon_ciclo_soltar\(\$1::text\)/,
    );
    expect(llamadas[0]!.valores).toEqual(["proceso-1"]);
  });
});

describe("errores de pg", () => {
  const casos: [string, (tx: never) => Promise<unknown>][] = [
    ["estudiosBuzon", (tx) => estudiosBuzon(tx)],
    ["tomarCiclo", (tx) => tomarCiclo(tx, "p")],
    ["renovarCiclo", (tx) => renovarCiclo(tx, "p")],
    ["soltarCiclo", (tx) => soltarCiclo(tx, "p")],
  ];
  it.each(casos)(
    "%s: sale como TrabajosRepoError con solo el SQLSTATE",
    async (_n, f) => {
      const e = await f(txFalso(errorPg("42501")).tx).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(TrabajosRepoError);
      expect((e as TrabajosRepoError).codigo).toBe("42501");
      expect(JSON.stringify(e) + (e as Error).message).not.toContain("CANARIO");
    },
  );
});

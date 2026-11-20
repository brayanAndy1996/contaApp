// Spec 023 (T4, rojo): repos de las funciones acotadas del programador (0055) sin BD. Contrato: tests/aislamiento/buzon-soporte.ts.
import { describe, expect, it } from "vitest";
import { errorPg, txFalso } from "../trabajos/soporte-prueba";
import { BuzonRepoError } from "./errores";
import {
  candidatosBuzon,
  elevarPrioridadBuzon,
  encolarBuzonProgramados,
} from "./programacion";

const C1 = "0190a000-0000-7000-8000-0000000000c1";
const C2 = "0190a000-0000-7000-8000-0000000000c2";
const J1 = "0190a000-0000-7000-8000-0000000000e1";
const J2 = "0190a000-0000-7000-8000-0000000000e2";

describe("candidatosBuzon", () => {
  it("llama a buzon_candidatos() sin parametros y devuelve clienteId y ultimaProgramadaEn (Date o null)", async () => {
    const f = new Date("2026-11-17T07:00:00Z");
    const { tx, llamadas } = txFalso({
      rows: [
        { cliente_id: C1, ultima_programada_en: f },
        { cliente_id: C2, ultima_programada_en: null },
      ],
    });
    expect(await candidatosBuzon(tx)).toEqual([
      { clienteId: C1, ultimaProgramadaEn: f },
      { clienteId: C2, ultimaProgramadaEn: null },
    ]);
    expect(llamadas[0]!.texto).toMatch(/buzon_candidatos\(\)/);
    expect(llamadas[0]!.valores).toEqual([]);
  });

  it("sin candidatos devuelve []", async () => {
    expect(await candidatosBuzon(txFalso({ rows: [] }).tx)).toEqual([]);
  });
});

describe("encolarBuzonProgramados", () => {
  it("pasa los clientes como uuid[] y devuelve los ids de los trabajos creados", async () => {
    const { tx, llamadas } = txFalso({
      rows: [
        { encolar_buzon_programados: J1 },
        { encolar_buzon_programados: J2 },
      ],
    });
    expect(await encolarBuzonProgramados(tx, [C1, C2])).toEqual([J1, J2]);
    expect(llamadas[0]!.texto).toMatch(
      /encolar_buzon_programados\(\$1::uuid\[\]\)/,
    );
    expect(llamadas[0]!.valores).toEqual([[C1, C2]]);
  });

  it("con lista vacia no consulta (la funcion la rechazaria con 22023) y devuelve []", async () => {
    const { tx, llamadas } = txFalso({ rows: [] });
    expect(await encolarBuzonProgramados(tx, [])).toEqual([]);
    expect(llamadas).toHaveLength(0);
  });

  it("un rechazo de la funcion (23503, 22023) sale como BuzonRepoError con solo el SQLSTATE", async () => {
    for (const code of ["23503", "22023", "42501"]) {
      const e = await encolarBuzonProgramados(txFalso(errorPg(code)).tx, [
        C1,
      ]).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(BuzonRepoError);
      expect((e as BuzonRepoError).codigo).toBe(code);
      expect(JSON.stringify(e) + (e as Error).message).not.toContain("CANARIO");
    }
  });
});

describe("elevarPrioridadBuzon", () => {
  it("llama a buzon_elevar_prioridad($1::uuid) y devuelve el booleano", async () => {
    const si = txFalso({ rows: [{ buzon_elevar_prioridad: true }] });
    expect(await elevarPrioridadBuzon(si.tx, J1)).toBe(true);
    expect(si.llamadas[0]!.texto).toMatch(
      /buzon_elevar_prioridad\(\$1::uuid\)/,
    );
    expect(si.llamadas[0]!.valores).toEqual([J1]);
    expect(
      await elevarPrioridadBuzon(txFalso({ rows: [{ x: false }] }).tx, J1),
    ).toBe(false);
    expect(await elevarPrioridadBuzon(txFalso({ rows: [] }).tx, J1)).toBe(
      false,
    );
  });

  it("un error de pg sale como BuzonRepoError", async () => {
    const e = await elevarPrioridadBuzon(
      txFalso(errorPg("42501")).tx,
      J1,
    ).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BuzonRepoError);
    expect((e as BuzonRepoError).codigo).toBe("42501");
  });
});

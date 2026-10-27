// Spec 008 (T3, rojo): repos de `sistema.*` y `auth.purgar` (D16, D18, CA-12, CA-13) sin BD. Se llaman con la tx de withSistema.
import { describe, expect, it } from "vitest";
import { TrabajosRepoError } from "./errores";
import { errorPg, txFalso } from "./soporte-prueba";
import { estudiosConTrabajos, estudiosIds, purgarAuth } from "./sistema";

const U1 = "00000000-0000-4000-8000-000000000001";
const U2 = "00000000-0000-4000-8000-000000000002";

describe("estudiosIds", () => {
  it("devuelve solo los uuid (la primera columna de cada fila), en el orden recibido", async () => {
    const { tx, llamadas } = txFalso({ rows: [{ estudios_ids: U1 }, { estudios_ids: U2 }] });
    expect(await estudiosIds(tx)).toEqual([U1, U2]);
    expect(llamadas[0]!.texto).toMatch(/sistema\.estudios_ids\(\)/);
  });

  it("funciona sea cual sea el nombre de la columna que devuelva la funcion", async () => {
    expect(await estudiosIds(txFalso({ rows: [{ id: U1 }] }).tx)).toEqual([U1]);
  });

  it("sin estudios devuelve []", async () => {
    expect(await estudiosIds(txFalso({ rows: [] }).tx)).toEqual([]);
  });

  it("un error de pg (sin permiso, funcion ausente) sale como TrabajosRepoError con el SQLSTATE", async () => {
    const e = await estudiosIds(txFalso(errorPg("42501")).tx).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TrabajosRepoError);
    expect((e as TrabajosRepoError).codigo).toBe("42501");
  });
});

describe("estudiosConTrabajos", () => {
  it("llama a sistema.estudios_con_trabajos con los estados y la antiguedad como parametros y devuelve los uuid", async () => {
    const { tx, llamadas } = txFalso({ rows: [{ x: U2 }] });
    expect(await estudiosConTrabajos(tx, ["en_cola", "ejecutando"], 300)).toEqual([U2]);
    const { texto, valores } = llamadas[0]!;
    expect(texto).toMatch(/sistema\.estudios_con_trabajos/);
    expect(texto).not.toContain("en_cola");
    expect(valores).toContainEqual(["en_cola", "ejecutando"]);
    expect(valores).toContain(300);
  });

  it("sin coincidencias devuelve []", async () => {
    expect(await estudiosConTrabajos(txFalso({ rows: [] }).tx, ["error"], 0)).toEqual([]);
  });

  it("un error de pg sale como TrabajosRepoError", async () => {
    const e = await estudiosConTrabajos(txFalso(errorPg("42883")).tx, ["en_cola"], 1).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TrabajosRepoError);
  });
});

describe("purgarAuth", () => {
  const RET = { sesionDias: 30, tokenDias: 7, intentoDias: 90, limiteDias: 1 };

  it("llama a auth.purgar con las cuatro retenciones como parametros y devuelve los conteos como numeros", async () => {
    const { tx, llamadas } = txFalso({ rows: [{ sesiones: 3, tokens: "2", intentos: 1, limites: 0 }] });
    expect(await purgarAuth(tx, RET)).toEqual({ sesiones: 3, tokens: 2, intentos: 1, limites: 0 });
    const { texto, valores } = llamadas[0]!;
    expect(texto).toMatch(/auth\.purgar/);
    expect(valores).toHaveLength(4);
    const planos = valores.map(String).join("|");
    expect(planos).toMatch(/30/);
    expect(planos).toMatch(/90/);
  });

  it("un error de pg (retencion < 1 dia, sin permiso) sale como TrabajosRepoError con el SQLSTATE", async () => {
    const e = await purgarAuth(txFalso(errorPg("22023")).tx, { ...RET, sesionDias: 0 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TrabajosRepoError);
    expect((e as TrabajosRepoError).codigo).toBe("22023");
  });
});

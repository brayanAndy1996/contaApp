// Spec 006 (T11, cobertura): repos de planes sin BD (tx falsa): mapeo de filas, ramas nulas y errores solo con SQLSTATE.
// Su comportamiento contra la BD real está en tests/aislamiento/planes-repos.spec.ts y planes-carreras.spec.ts.
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { bloquearCupo, contarRucs, contarUsuarios, leerLimites } from "./cupo";
import { consultar, PlanesRepoError, type TxConsulta } from "./errores";
import { usoDelEstudio } from "./uso";

const T = "01920000-0000-7000-8000-0000000000a1";

function txFalso(rows: unknown[]) {
  const llamadas: Array<{ texto: string; valores: unknown[] }> = [];
  const tx = {
    query: async (texto: string, valores: unknown[] = []) => {
      llamadas.push({ texto, valores });
      return { rows, rowCount: rows.length };
    },
  } as unknown as TxConsulta;
  return { tx, llamadas };
}
const txQueFalla = (error: unknown) =>
  ({
    query: async () => {
      throw error;
    },
  }) as unknown as TxConsulta;

describe("PlanesRepoError", () => {
  it("conserva el SQLSTATE válido y nombra la clase", () => {
    const e = PlanesRepoError.desde({ code: "23505", message: "dup", detail: "Key (x)=(secreto)" });
    expect(e).toBeInstanceOf(PlanesRepoError);
    expect(e.codigo).toBe("23505");
    expect(e.name).toBe("PlanesRepoError");
    expect(e.message).toBe("Error de base de datos en planes (SQLSTATE 23505)");
    expect(Object.keys(e)).toEqual(["codigo"]);
    expect(inspect(e)).not.toContain("secreto");
  });

  it.each([
    [{ code: "abc" }],
    [{ code: 23505 }],
    [{ code: "230505" }],
    [{}],
    ["texto"],
    [null],
    [undefined],
  ])("un error sin SQLSTATE válido (%j) da 'desconocido'", (error) => {
    expect(PlanesRepoError.desde(error).codigo).toBe("desconocido");
  });

  it("consultar devuelve las filas y, ante un fallo de pg, lanza PlanesRepoError sin el error original", async () => {
    const { tx, llamadas } = txFalso([{ a: 1 }]);
    expect(await consultar(tx, "select 1", [T])).toEqual([{ a: 1 }]);
    expect(llamadas[0]).toEqual({ texto: "select 1", valores: [T] });
    const e = await consultar(txQueFalla({ code: "40P01", message: "deadlock con CANARIO-T11" }), "select 1", []).catch(
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(PlanesRepoError);
    expect((e as PlanesRepoError).codigo).toBe("40P01");
    expect((e as Error).message).not.toContain("CANARIO-T11");
  });
});

describe("cupo", () => {
  it("bloquearCupo ejecuta el advisory lock con el estudio como único parámetro", async () => {
    const { tx, llamadas } = txFalso([{}]);
    await expect(bloquearCupo(tx, T)).resolves.toBeUndefined();
    expect(llamadas[0]!.texto).toContain("pg_advisory_xact_lock(hashtextextended('plan.cupo:'");
    expect(llamadas[0]!.valores).toEqual([T]);
  });

  it("leerLimites: sin fila -> null; con fila convierte a number y respeta maxUsuarios null", async () => {
    expect(await leerLimites(txFalso([]).tx, T)).toBeNull();
    const fila = { max_rucs: "30", max_usuarios: "2", max_rucs_extra: "6", rucs_extra_contratados: "1" };
    expect(await leerLimites(txFalso([fila]).tx, T)).toEqual({
      maxRucs: 30,
      maxUsuarios: 2,
      maxRucsExtra: 6,
      rucsExtraContratados: 1,
    });
    expect((await leerLimites(txFalso([{ ...fila, max_usuarios: null }]).tx, T))?.maxUsuarios).toBeNull();
  });

  it("contarUsuarios y contarRucs devuelven números", async () => {
    expect(await contarUsuarios(txFalso([{ activos: "3", pendientes: "1" }]).tx, T)).toEqual({
      activos: 3,
      pendientes: 1,
    });
    expect(await contarRucs(txFalso([{ n: "7" }]).tx, T)).toBe(7);
  });

  it("un fallo de pg sale como PlanesRepoError", async () => {
    for (const llamar of [
      () => bloquearCupo(txQueFalla({ code: "55P03" }), T),
      () => leerLimites(txQueFalla({ code: "55P03" }), T),
      () => contarUsuarios(txQueFalla({ code: "55P03" }), T),
      () => contarRucs(txQueFalla({ code: "55P03" }), T),
      () => usoDelEstudio(txQueFalla({ code: "55P03" }), T),
    ]) {
      const e = await llamar().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(PlanesRepoError);
      expect((e as PlanesRepoError).codigo).toBe("55P03");
    }
  });
});

describe("usoDelEstudio", () => {
  const venc = new Date("2026-12-01T00:00:00.000Z");
  const fila = {
    codigo: "estudio",
    nombre: "Estudio",
    estado: "prueba",
    prueba_vence_en: venc,
    max_rucs: "100",
    max_usuarios: "5",
    max_rucs_extra: "20",
    rucs_extra_contratados: "2",
    rucs_usados: "10",
    activos: "3",
    pendientes: "1",
  };

  it("sin suscripción -> null", async () => {
    expect(await usoDelEstudio(txFalso([]).tx, T)).toBeNull();
  });

  it("arma el uso con números, el vencimiento de la prueba y los conteos", async () => {
    const { tx, llamadas } = txFalso([fila]);
    expect(await usoDelEstudio(tx, T)).toEqual({
      plan: { codigo: "estudio", nombre: "Estudio" },
      estado: "prueba",
      pruebaVenceEn: venc,
      maxRucs: 100,
      maxUsuarios: 5,
      maxRucsExtra: 20,
      rucsExtraContratados: 2,
      rucsUsados: 10,
      usuarios: { activos: 3, pendientes: 1 },
    });
    expect(llamadas[0]!.valores).toEqual([T]);
  });

  it("sin vencimiento (activa) -> null y sin límite de usuarios -> null", async () => {
    const r = await usoDelEstudio(
      txFalso([{ ...fila, estado: "activa", prueba_vence_en: null, max_usuarios: null }]).tx,
      T,
    );
    expect(r).toMatchObject({ estado: "activa", pruebaVenceEn: null, maxUsuarios: null });
    expect((await usoDelEstudio(txFalso([{ ...fila, prueba_vence_en: undefined }]).tx, T))?.pruebaVenceEn).toBeNull();
  });
});

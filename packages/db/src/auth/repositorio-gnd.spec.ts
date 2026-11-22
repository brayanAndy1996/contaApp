// Spec 027 (T10): las cuatro funciones del diccionario global de AuthRepo sin BD (tx falsa): SQL estático con parámetros posicionales,
// mapeo a camelCase y errores reducidos a su SQLSTATE. El comportamiento de las funciones SQL está en
// tests/aislamiento/gnd-plataforma.spec.ts.
import { describe, expect, it } from "vitest";
import { AuthRepoError } from "./errores";
import { crearAuthRepo, type TxConsulta } from "./repositorio";

const SESION = Buffer.alloc(32, 6);
const G = "01920000-0000-7000-8000-0000000000c1";
const U = "01920000-0000-7000-8000-0000000000d1";
const AHORA = new Date("2026-11-22T10:00:00Z");

function txFalso(rows: unknown[]) {
  const llamadas: Array<{ texto: string; valores: unknown[] }> = [];
  const tx = {
    query: async (texto: string, valores: unknown[] = []) => {
      llamadas.push({ texto, valores });
      return { rows, rowCount: rows.length };
    },
  } as unknown as TxConsulta;
  return { repo: crearAuthRepo(tx), llamadas };
}

const FILA = {
  id: G,
  palabra: "patineta",
  categoria: "juguetes",
  excepciones: ["electrica"],
  activa: true,
  version: 1,
  actualizada_en: AHORA,
};

describe("AuthRepo: diccionario global (027, D-2)", () => {
  it("gndGlobalAgregar: llama a auth.gnd_global_agregar con parámetros posicionales y devuelve la fila en camelCase", async () => {
    const { repo, llamadas } = txFalso([FILA]);
    const r = await repo.gndGlobalAgregar(SESION, {
      palabra: "patineta",
      categoria: "juguetes",
      excepciones: ["electrica"],
    });
    expect(r).toEqual({
      id: G,
      palabra: "patineta",
      categoria: "juguetes",
      excepciones: ["electrica"],
      activa: true,
      version: 1,
      actualizadaEn: AHORA,
    });
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]!.texto).toMatch(/^select \* from auth\.gnd_global_agregar\(\$1::bytea, \$2::text, \$3::text, \$4::text\[\]\)$/);
    expect(llamadas[0]!.texto).not.toContain("patineta");
    expect(llamadas[0]!.valores).toEqual([SESION, "patineta", "juguetes", ["electrica"]]);
  });

  it("gndGlobalListar, gndGlobalEditar y gndGlobalHistorial mapean sus filas", async () => {
    expect(await txFalso([FILA]).repo.gndGlobalListar(SESION)).toHaveLength(1);
    const ed = txFalso([{ ...FILA, version: 2, activa: false }]);
    const r = await ed.repo.gndGlobalEditar(SESION, G, {
      categoria: "juguetes",
      excepciones: [],
      activa: false,
      version: 1,
    });
    expect([r.activa, r.version]).toEqual([false, 2]);
    expect(ed.llamadas[0]!.valores).toEqual([SESION, G, "juguetes", [], false, 1]);
    const h = await txFalso([
      {
        id: U,
        palabra_global_id: G,
        palabra: "patineta",
        accion: "editada",
        antes: { version: 1 },
        despues: { version: 2 },
        usuario_id: U,
        usuario_nombre: "Admin",
        ocurrida_en: AHORA,
      },
    ]).repo.gndGlobalHistorial(SESION, 50, null);
    expect(h).toEqual([
      {
        id: U,
        palabraGlobalId: G,
        palabra: "patineta",
        accion: "editada",
        antes: { version: 1 },
        despues: { version: 2 },
        autor: { id: U, nombre: "Admin" },
        ocurridaEn: AHORA,
      },
    ]);
  });

  it("un rechazo de la BD (CA420) sale como AuthRepoError con solo su SQLSTATE, sin el mensaje original", async () => {
    const repo = crearAuthRepo({
      query: async () => {
        throw Object.assign(new Error("palabra patineta ya existe"), { code: "CA420" });
      },
    } as unknown as TxConsulta);
    const e = await repo
      .gndGlobalAgregar(SESION, { palabra: "patineta", categoria: "juguetes", excepciones: [] })
      .then(
        () => null,
        (x: unknown) => x,
      );
    expect(e).toBeInstanceOf(AuthRepoError);
    expect((e as AuthRepoError).codigo).toBe("CA420");
    expect((e as AuthRepoError).message).not.toContain("patineta");
  });
});

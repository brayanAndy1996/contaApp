// Spec 027 · T20 (H-027-2-3, 0072): frases de excepción sugeridas al aprender (`gnd_excepciones_sugeridas`) y `aprender` con
// `excepciones` por término. Caso feliz y de error de cada comportamiento público nuevo del repositorio. Necesita DATABASE_URL y
// MIGRATIONS_DATABASE_URL: si faltan, FALLA (no se salta).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TxConsulta } from "../compras/errores";
import { aprender, excepcionesSugeridas } from "./index";
import { abrirArnes, falla, type Arnes } from "./soporte-prueba";

let h: Arnes;

beforeAll(async () => {
  h = await abrirArnes();
}, 60_000);

afterAll(async () => {
  await h?.cerrar();
});

const sugeridas = (terminos: readonly string[]) => h.comoDueno((tx) => excepcionesSugeridas(tx, terminos));

describe("excepcionesSugeridas (0072)", () => {
  it("solo los términos que tienen frases, en cualquiera de sus formas; sin términos no consulta", async () => {
    const r = await sugeridas(["media", "audifonos", "lentes", "tirante"]);
    expect(Object.keys(r).sort()).toEqual(["lentes", "media", "tirante"]);
    expect(r.media).toContain("media pulgada");
    expect(r.lentes).toContain("camara");
    for (const frases of Object.values(r)) {
      expect(frases.length).toBeGreaterThanOrEqual(1);
      expect(frases.length).toBeLessThanOrEqual(5);
      for (const f of frases) expect(f).toMatch(/^[a-z0-9]+( [a-z0-9]+){0,2}$/);
    }
    expect(await sugeridas(["audifonos"])).toEqual({});
    let consultas = 0;
    const tx = { query: async () => (consultas++, { rows: [] }) } as unknown as TxConsulta;
    expect(await excepcionesSugeridas(tx, [])).toEqual({});
    expect(consultas).toBe(0);
  });

  it("términos inválidos: 22023 (de la BD con uno fuera de la gramática o más de 10; del repositorio si no es una lista de textos)", async () => {
    expect((await falla(sugeridas(["MEDIAS"]))).codigo).toBe("22023");
    expect((await falla(sugeridas(Array.from({ length: 11 }, (_, i) => `termino${String.fromCharCode(97 + i)}`)))).codigo).toBe("22023");
    expect((await falla(sugeridas([42 as unknown as string]))).codigo).toBe("22023");
    expect((await falla(sugeridas("medias" as unknown as string[]))).codigo).toBe("22023");
  });
});

describe("aprender con excepciones (0072): validación del repositorio", () => {
  const tx = { query: async () => ({ rows: [] }) } as unknown as TxConsulta;
  const base = { clienteId: "00000000-0000-4000-8000-000000000001", compraId: "00000000-0000-4000-8000-000000000002" };

  it("excepciones que no son una lista de textos: 22023 sin consultar", async () => {
    for (const excepciones of ["media pulgada", [42], null]) {
      const e = await falla(aprender(tx, { ...base, terminos: [{ termino: "medias", categoria: "calzado-ropa", excepciones } as never] }));
      expect(e.codigo).toBe("22023");
    }
  });

  it("con excepciones válidas llega a la función y lee su respuesta", async () => {
    let enviado: unknown;
    const espia = {
      query: async (_sql: string, valores: unknown[]) => {
        enviado = JSON.parse(String(valores[2]));
        return { rows: [{ r: { guardadas: ["medias"], omitidas: [] } }] };
      },
    } as unknown as TxConsulta;
    const r = await aprender(espia, {
      ...base,
      terminos: [{ termino: "medias", categoria: "calzado-ropa", excepciones: ["media pulgada"] }, { termino: "lentes", categoria: "cuidado-personal" }],
    });
    expect(r).toEqual({ guardadas: ["medias"], omitidas: [] });
    expect(enviado).toEqual([
      { termino: "medias", categoria: "calzado-ropa", excepciones: ["media pulgada"] },
      { termino: "lentes", categoria: "cuidado-personal" },
    ]);
  });
});

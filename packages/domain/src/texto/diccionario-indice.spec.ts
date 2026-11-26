// Spec 027 · T8: índice del diccionario con palabras repetidas (determinista, R-2) y bordes de la validación.
import { describe, expect, it } from "vitest";
import { DiccionarioGlosas } from "./diccionario";

const palabras = (d: DiccionarioGlosas, glosa: string) => d.coincidenciasPorItem([glosa]);

describe("DiccionarioGlosas · palabra repetida en varias entradas", () => {
  it("gana la categoría menor en orden de código, sin importar el orden de las entradas", () => {
    const a = DiccionarioGlosas.desde([
      { categoria: "juguetes", palabras: ["pelota"] },
      { categoria: "entretenimiento", palabras: ["pelota"] },
    ]);
    const b = DiccionarioGlosas.desde([
      { categoria: "entretenimiento", palabras: ["pelota"] },
      { categoria: "juguetes", palabras: ["pelota"] },
    ]);
    expect(palabras(a, "pelota")).toEqual([{ item: 0, palabra: "pelota", categoria: "entretenimiento" }]);
    expect(palabras(b, "pelota")).toEqual(palabras(a, "pelota"));
  });

  it("con la misma categoría se unen sus excepciones", () => {
    const d = DiccionarioGlosas.desde([
      { categoria: "calzado-ropa", palabras: ["bota"], excepciones: ["seguridad"] },
      { categoria: "calzado-ropa", palabras: ["bota"], excepciones: ["jebe", "seguridad"] },
      { categoria: "calzado-ropa", palabras: ["bota"] },
    ]);
    expect(palabras(d, "bota de jebe")).toEqual([]);
    expect(palabras(d, "bota de seguridad")).toEqual([]);
    expect(palabras(d, "bota de cuero")).toEqual([{ item: 0, palabra: "bota", categoria: "calzado-ropa" }]);
  });
});

describe("DiccionarioGlosas · validación y marca", () => {
  it("una palabra que se parte en dos tokens o una excepción que no es texto lanzan RangeError", () => {
    expect(() => DiccionarioGlosas.desde([{ categoria: "x", palabras: ["zap.ato"] }])).toThrow(RangeError);
    expect(() => DiccionarioGlosas.desde([{ categoria: "x", palabras: ["bota"], excepciones: [1 as never] }])).toThrow(RangeError);
    expect(() => DiccionarioGlosas.desde([{ categoria: "x", palabras: ["bota"], excepciones: "jebe" as never }])).toThrow(RangeError);
  });

  it("esInstancia reconoce solo instancias reales", () => {
    expect(DiccionarioGlosas.esInstancia(DiccionarioGlosas.desde([]))).toBe(true);
    expect(DiccionarioGlosas.esInstancia(Object.create(DiccionarioGlosas.prototype))).toBe(false);
    expect(DiccionarioGlosas.esInstancia(null)).toBe(false);
    expect(DiccionarioGlosas.esInstancia({ coincidenciasPorItem: () => [] })).toBe(false);
  });
});

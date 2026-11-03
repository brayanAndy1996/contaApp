import { beforeEach, describe, expect, it } from "vitest";
import * as dominio from "../index";

// Spec 011, CA-12 y D-5 (R-GP mínima): coincidencia de palabras clave con plural s/es,
// abreviatura con punto (prefijo, >= 4 letras) y diccionario base. Contrato: plan 011, "texto/".

interface EntradaDiccionario {
  readonly categoria: string;
  readonly palabras: readonly string[];
}
interface Coincidencia {
  palabra: string;
  categoria: string;
}
interface Diccionario {
  buscar: (glosas: readonly string[]) => Coincidencia | null;
}
interface ApiDiccionario {
  DiccionarioGlosas: {
    desde: (e: readonly EntradaDiccionario[]) => Diccionario;
  };
  DICCIONARIO_GLOSAS_BASE: Diccionario;
}
const api = dominio as unknown as Partial<ApiDiccionario>;
const clase = (): ApiDiccionario["DiccionarioGlosas"] =>
  api.DiccionarioGlosas as ApiDiccionario["DiccionarioGlosas"];
const base = (): Diccionario => api.DICCIONARIO_GLOSAS_BASE as Diccionario;
const desde = (e: readonly EntradaDiccionario[]): Diccionario =>
  clase().desde(e);

/** Si la API pública aún no exporta algo, TODA prueba falla por esa razón (rojo explícito). */
beforeEach(() => {
  expect(
    typeof api.DiccionarioGlosas,
    "DiccionarioGlosas no está exportada por @contapp/domain",
  ).toBe("function");
  expect(
    api.DICCIONARIO_GLOSAS_BASE,
    "DICCIONARIO_GLOSAS_BASE no está exportado por @contapp/domain",
  ).toBeDefined();
});

describe("CA-12: caso real zapatilla con el diccionario base", () => {
  it("'ZAPATILLAS URBANAS T-42' coincide con 'zapatilla' (calzado-ropa)", () => {
    expect(base().buscar(["ZAPATILLAS URBANAS T-42"])).toEqual({
      palabra: "zapatilla",
      categoria: "calzado-ropa",
    });
  });

  it("'Zapatíllas' (tilde y mayúscula) coincide", () => {
    expect(base().buscar(["Zapatíllas"])?.palabra).toBe("zapatilla");
  });

  it("'zapat. dep.' coincide por abreviatura con punto", () => {
    expect(base().buscar(["zapat. dep."])).toEqual({
      palabra: "zapatilla",
      categoria: "calzado-ropa",
    });
  });

  it("'zapata de concreto' NO coincide", () => {
    expect(base().buscar(["zapata de concreto"])).toBeNull();
  });

  it("'zap.' NO coincide (abreviatura de menos de 4 letras)", () => {
    expect(base().buscar(["zap."])).toBeNull();
    expect(base().buscar(["zap. dep."])).toBeNull();
  });

  it("la abreviatura exige el punto: 'zapat' sin punto NO coincide", () => {
    expect(base().buscar(["zapat dep"])).toBeNull();
  });

  it("separadores: la palabra se encuentra tras |, salto de línea, tabulación y NBSP", () => {
    for (const sep of ["|", "\n", "\t", " "]) {
      expect(
        base().buscar([`servicio${sep}zapatillas${sep}flete`])?.palabra,
      ).toBe("zapatilla");
    }
  });

  it("cadena vacía, glosas vacías y lista vacía → null", () => {
    expect(base().buscar([""])).toBeNull();
    expect(base().buscar(["", " \t\n"])).toBeNull();
    expect(base().buscar([])).toBeNull();
  });

  it("glosa sin palabras clave → null", () => {
    expect(base().buscar(["Servicio de transporte de carga"])).toBeNull();
  });
});

describe("diccionario base: palabras y categorías del plan", () => {
  it.each([
    [
      "calzado-ropa",
      ["zapatilla", "zapato", "polo", "casaca", "blusa", "vestido"],
    ],
    ["juguetes", ["juguete", "peluche", "muñeca"]],
    ["cuidado-personal", ["perfume", "colonia", "maquillaje", "labial"]],
    ["entretenimiento", ["videojuego", "cine"]],
  ])("categoría %s", (categoria, palabras) => {
    for (const p of palabras) {
      expect(base().buscar([`compra de ${p}`])?.categoria, p).toBe(categoria);
    }
  });

  it("la eñe se normaliza: 'MUÑECAS' y 'muneca' coinciden", () => {
    expect(base().buscar(["MUÑECAS"])?.categoria).toBe("juguetes");
    expect(base().buscar(["muneca"])?.categoria).toBe("juguetes");
  });

  it("coincide con el plural simple: 'zapatos', 'polos', 'perfumes'", () => {
    expect(base().buscar(["zapatos"])?.palabra).toBe("zapato");
    expect(base().buscar(["polos"])?.palabra).toBe("polo");
    expect(base().buscar(["perfumes"])?.palabra).toBe("perfume");
  });
});

describe("DICCIONARIO_GLOSAS_BASE congelado", () => {
  it("el objeto está congelado", () => {
    expect(Object.isFrozen(base())).toBe(true);
  });

  it("no se puede alterar: agregar o reemplazar propiedades falla o no tiene efecto", () => {
    const d = base() as unknown as Record<string, unknown>;
    try {
      d["buscar"] = () => ({ palabra: "x", categoria: "y" });
      d["extra"] = 1;
    } catch {
      /* modo estricto: lanzar es válido */
    }
    expect(d["extra"]).toBeUndefined();
    expect(base().buscar(["servicio de transporte"])).toBeNull();
  });
});

describe("DiccionarioGlosas.desde: validación", () => {
  it.each([
    ["palabra vacía", ""],
    ["solo espacios", "   "],
    ["con espacios internos", "zapatilla deportiva"],
    ["con espacio al inicio", " zapatilla"],
    ["con espacio al final", "zapatilla "],
    ["con tabulación", "zapa\ttilla"],
    ["1 letra", "a"],
    ["2 letras", "ab"],
    ["2 letras con tilde", "añ"],
  ])("rechaza %s", (_n, palabra) => {
    expect(() => desde([{ categoria: "x", palabras: [palabra] }])).toThrow();
  });

  it("rechaza una palabra inválida aunque otras sean válidas", () => {
    expect(() =>
      desde([{ categoria: "x", palabras: ["perfume", "ab", "colonia"] }]),
    ).toThrow();
  });

  it("acepta palabras de 3 letras y diccionario vacío", () => {
    expect(() => desde([{ categoria: "x", palabras: ["pan"] }])).not.toThrow();
    expect(desde([]).buscar(["pan"])).toBeNull();
    expect(
      desde([{ categoria: "x", palabras: [] }]).buscar(["pan"]),
    ).toBeNull();
  });

  it("una palabra de 3 letras coincide exacta: 'pan' → 'pan'", () => {
    expect(
      desde([{ categoria: "x", palabras: ["pan"] }]).buscar(["pan"]),
    ).toEqual({ palabra: "pan", categoria: "x" });
  });
});

describe("coincidencia: igualdad, plural s/es y abreviatura", () => {
  const d = (): Diccionario =>
    desde([{ categoria: "ropa", palabras: ["pantalon", "zapatilla"] }]);

  it("igual a la palabra", () => {
    expect(d().buscar(["pantalon"])).toEqual({
      palabra: "pantalon",
      categoria: "ropa",
    });
  });

  it("plural 's': 'zapatillas'", () => {
    expect(d().buscar(["zapatillas"])?.palabra).toBe("zapatilla");
  });

  it("plural 'es': 'pantalones'", () => {
    expect(d().buscar(["pantalones"])?.palabra).toBe("pantalon");
  });

  it("no coincide con otra palabra que solo comparte prefijo sin punto: 'pantalonera'", () => {
    expect(d().buscar(["pantalonera"])).toBeNull();
  });

  it("no coincide con una palabra más corta contenida: 'zapati'", () => {
    expect(d().buscar(["zapati"])).toBeNull();
  });

  it("abreviatura de exactamente 4 letras con punto coincide: 'pant.'", () => {
    expect(d().buscar(["pant."])?.palabra).toBe("pantalon");
  });

  it("abreviatura de 3 letras con punto NO coincide: 'pan.'", () => {
    expect(d().buscar(["pan."])).toBeNull();
  });

  it("una abreviatura que no es prefijo NO coincide: 'pent.' / 'xapat.'", () => {
    expect(d().buscar(["pent."])).toBeNull();
    expect(d().buscar(["xapat."])).toBeNull();
  });

  it("solo puntos o un punto suelto no coinciden con nada", () => {
    expect(d().buscar(["."])).toBeNull();
    expect(d().buscar(["...."])).toBeNull();
    expect(d().buscar([". . . ."])).toBeNull();
  });

  it("la categoría devuelta es la de la palabra encontrada", () => {
    const e = desde([
      { categoria: "a", palabras: ["alfa"] },
      { categoria: "b", palabras: ["beta"] },
    ]);
    expect(e.buscar(["beta"])).toEqual({ palabra: "beta", categoria: "b" });
  });
});

describe("orden determinista de buscar", () => {
  const e = (): Diccionario =>
    desde([
      { categoria: "A", palabras: ["gamma"] },
      { categoria: "B", palabras: ["alfa", "beta"] },
    ]);

  it("varias glosas: gana la primera glosa con coincidencia", () => {
    expect(e().buscar(["nada", "beta", "gamma"])).toEqual({
      palabra: "beta",
      categoria: "B",
    });
    expect(e().buscar(["gamma", "beta"])).toEqual({
      palabra: "gamma",
      categoria: "A",
    });
  });

  it("varias palabras en la misma glosa: gana la primera del diccionario", () => {
    expect(e().buscar(["alfa gamma"])).toEqual({
      palabra: "gamma",
      categoria: "A",
    });
    expect(e().buscar(["gamma alfa"])).toEqual({
      palabra: "gamma",
      categoria: "A",
    });
    expect(e().buscar(["beta alfa"])).toEqual({
      palabra: "alfa",
      categoria: "B",
    });
  });

  it("mismas entradas, mismo resultado, en cualquier número de llamadas y en dos diccionarios", () => {
    const glosas = ["x alfa", "gamma"];
    const r = e().buscar(glosas);
    for (let i = 0; i < 5; i++) expect(e().buscar(glosas)).toEqual(r);
    const d = e();
    expect(d.buscar(glosas)).toEqual(d.buscar(glosas));
  });

  it("no depende de mutar las entradas después de construir el diccionario", () => {
    const palabras = ["alfa"];
    const entradas = [{ categoria: "A", palabras }];
    const d = desde(entradas);
    palabras.push("beta");
    palabras[0] = "omega";
    entradas.push({ categoria: "B", palabras: ["gamma"] });
    expect(d.buscar(["alfa"])).toEqual({ palabra: "alfa", categoria: "A" });
    expect(d.buscar(["beta"])).toBeNull();
    expect(d.buscar(["omega"])).toBeNull();
    expect(d.buscar(["gamma"])).toBeNull();
  });

  it("no falla con una lista de glosas congelada (no se muta)", () => {
    const glosas = Object.freeze(["x", "alfa"]);
    expect(() => e().buscar(glosas)).not.toThrow();
    expect(e().buscar(glosas)?.palabra).toBe("alfa");
  });
});

describe("rendimiento: glosa de 1 MB en menos de 1 s", () => {
  it("1 MB de palabras sin coincidencia (diccionario base)", () => {
    const glosa = "producto ".repeat(125_000);
    const t0 = Date.now();
    expect(base().buscar([glosa])).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("1 MB con la palabra clave al final", () => {
    const glosa = `${"producto ".repeat(125_000)}zapatillas`;
    const t0 = Date.now();
    expect(base().buscar([glosa])?.palabra).toBe("zapatilla");
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it.each([
    ["una sola palabra", "x".repeat(1_000_000)],
    ["puntos", ".".repeat(1_000_000)],
    ["abreviaturas cortas repetidas", "zap. ".repeat(200_000)],
    ["prefijo repetido sin punto", "zapatill ".repeat(111_000)],
  ])("1 MB patológico (%s)", (_n, glosa) => {
    const t0 = Date.now();
    base().buscar([glosa]);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("muchas glosas pequeñas (100 000) en menos de 1 s", () => {
    const glosas = Array.from({ length: 100_000 }, (_, i) => `articulo ${i}`);
    const t0 = Date.now();
    expect(base().buscar(glosas)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

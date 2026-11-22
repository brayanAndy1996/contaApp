// Spec 027 · T1 (rojo). Diccionario ampliado (R-4, CA-4; plan, Contratos: domain `texto/diccionario.ts`): frases de excepción por palabra,
// índice por token y `coincidenciasPorItem(glosas) → {item, palabra, categoria}[]` (`item` = índice del ítem desde 0; por ítem, todas
// las palabras coincidentes sin las anuladas por excepción, en orden de código). `buscar` se conserva (lo cubre `diccionario.spec.ts`).
import { beforeEach, describe, expect, it } from "vitest";
import { entradasSemilla } from "../../tests/ayudas/gastos";
import { DiccionarioGlosas } from "./diccionario";

/** Rojo explícito: las pruebas de excepciones y de orden no pueden pasar por casualidad sin el método nuevo. */
beforeEach(() => {
  expect(typeof DiccionarioGlosas.prototype.coincidenciasPorItem, "DiccionarioGlosas.coincidenciasPorItem no existe").toBe("function");
});

const semilla = (): DiccionarioGlosas => DiccionarioGlosas.desde(entradasSemilla());
const palabras = (d: DiccionarioGlosas, ...glosas: string[]): string[] => d.coincidenciasPorItem(glosas).map((c) => c.palabra);
const zapatilla = (excepciones: string[]) => DiccionarioGlosas.desde([{ categoria: "calzado-ropa", palabras: ["zapatilla"], excepciones }]);

describe("CA-4 · las variantes de zapatilla puntúan y las excepciones no", () => {
  it.each([
    ["ZAPATILLAS URBANAS T-42"],
    ["ZAPATILLAS.38"],
    ["zapatilla."],
    ["Par de zapatillas deportivas de prueba (PRUEBA)"],
    ["ZAPATÍLLAS URBANAS"],
    ["ＺＡＰＡＴＩＬＬＡＳ"],
  ])("%j coincide con zapatilla", (glosa) => {
    expect(semilla().coincidenciasPorItem([glosa])).toEqual([{ item: 0, palabra: "zapatilla", categoria: "calzado-ropa" }]);
  });

  it.each([["zapata de concreto"], ["zapatilla de seguridad"], ["polo a tierra"], ["zap. de seguridad"], ["POLONIA"], ["cinematografica"]])(
    "%j no coincide con nada",
    (glosa) => {
      expect(semilla().coincidenciasPorItem([glosa])).toEqual([]);
    },
  );
});

describe("CA-4 · abreviatura con punto (prefijo de 4 o más letras de cada palabra)", () => {
  it("«zapat. dep.» coincide con zapatilla y con zapato (ambas empiezan con «zapat»), en orden de código", () => {
    expect(semilla().coincidenciasPorItem(["zapat. dep."])).toEqual([
      { item: 0, palabra: "zapatilla", categoria: "calzado-ropa" },
      { item: 0, palabra: "zapato", categoria: "calzado-ropa" },
    ]);
  });

  it("«zapati.» solo coincide con zapatilla", () => {
    expect(palabras(semilla(), "zapati. dep.")).toEqual(["zapatilla"]);
  });
});

describe("frases de excepción (R-4, U-4)", () => {
  it("«seguridad» anula zapatilla en su ítem, con cualquier caja, plural y tilde", () => {
    const d = zapatilla(["seguridad"]);
    for (const g of ["zapatilla de seguridad", "ZAPATILLAS DE SEGURIDAD", "zapatilla SEGURIDÁD industrial", "seguridad: zapatilla"]) {
      expect(d.coincidenciasPorItem([g]), g).toEqual([]);
    }
  });

  it("la frase de 3 palabras «punta de acero» anula; si no están seguidas, no anula", () => {
    const d = DiccionarioGlosas.desde(entradasSemilla());
    expect(palabras(d, "zapatilla punta de acero")).toEqual([]);
    expect(palabras(d, "ZAPATO CON PUNTA DE ACERO")).toEqual([]);
    expect(palabras(d, "zapatilla con punta y de acero")).toEqual(["zapatilla"]);
  });

  it("la frase de 2 palabras «a tierra» anula polo; «polo a la tierra» (no seguidas) no", () => {
    const d = semilla();
    expect(palabras(d, "polo a tierra")).toEqual([]);
    expect(palabras(d, "polo a la tierra")).toEqual(["polo"]);
  });

  it("una excepción en otro ítem no anula la palabra de este", () => {
    const d = semilla();
    expect(d.coincidenciasPorItem(["zapatilla urbana", "casco de seguridad"])).toEqual([
      { item: 0, palabra: "zapatilla", categoria: "calzado-ropa" },
    ]);
  });

  it("la excepción solo anula a su palabra: zapatilla de seguridad con polo deja polo", () => {
    expect(palabras(semilla(), "zapatilla y polo de seguridad")).toEqual(["polo"]);
  });

  it("varias frases: basta con una", () => {
    const d = zapatilla(["jebe", "seguridad", "punta de acero"]);
    expect(palabras(d, "zapatilla jebe")).toEqual([]);
    expect(palabras(d, "zapatilla punta de acero")).toEqual([]);
    expect(palabras(d, "zapatilla blanca")).toEqual(["zapatilla"]);
  });

  it("una palabra sin excepciones no se ve afectada por las de otras", () => {
    expect(palabras(semilla(), "sandalia de seguridad")).toEqual(["sandalia"]);
  });

  it("una excepción dentro de una abreviatura con punto: «zapat. seguridad» se anula igual", () => {
    expect(palabras(zapatilla(["seguridad"]), "zapat. seguridad")).toEqual([]);
  });
});

describe("validación de las excepciones", () => {
  it("hasta 5 frases de 1 a 3 palabras son válidas", () => {
    expect(() => zapatilla(["a", "b c", "d e f", "uno", "dos tres"])).not.toThrow();
  });

  it("6 frases lanzan RangeError", () => {
    expect(() => zapatilla(["a1", "b2", "c3", "d4", "e5", "f6"])).toThrow(RangeError);
  });

  it("una frase de 4 palabras o vacía lanza RangeError", () => {
    expect(() => zapatilla(["uno dos tres cuatro"])).toThrow(RangeError);
    expect(() => zapatilla([""])).toThrow(RangeError);
    expect(() => zapatilla(["   "])).toThrow(RangeError);
  });

  it("mutar las excepciones recibidas después no afecta al diccionario", () => {
    const ex = ["seguridad"];
    const d = zapatilla(ex);
    ex.push("urbana");
    ex[0] = "otra";
    expect(palabras(d, "zapatilla de seguridad")).toEqual([]);
    expect(palabras(d, "zapatilla urbana")).toEqual(["zapatilla"]);
  });

  it("las entradas sin `excepciones` siguen siendo válidas (011)", () => {
    const d = DiccionarioGlosas.desde([{ categoria: "juguetes", palabras: ["juguete", "peluche"] }]);
    expect(palabras(d, "peluches grandes")).toEqual(["peluche"]);
  });
});

describe("coincidenciasPorItem · orden y forma", () => {
  it("por ítem y, dentro del ítem, en orden de código de la palabra", () => {
    const d = semilla();
    expect(d.coincidenciasPorItem(["zapatilla con perfume y polo", "cable", "peluche"])).toEqual([
      { item: 0, palabra: "perfume", categoria: "cuidado-personal" },
      { item: 0, palabra: "polo", categoria: "calzado-ropa" },
      { item: 0, palabra: "zapatilla", categoria: "calzado-ropa" },
      { item: 2, palabra: "peluche", categoria: "juguetes" },
    ]);
  });

  it("el orden del diccionario o de las entradas no cambia el resultado", () => {
    const entradas = entradasSemilla();
    const a = DiccionarioGlosas.desde(entradas);
    const b = DiccionarioGlosas.desde([...entradas].reverse());
    const glosas = ["zapatilla con perfume y polo", "peluche y chocolate", "mochila escolar"];
    expect(b.coincidenciasPorItem(glosas)).toEqual(a.coincidenciasPorItem(glosas));
  });

  it("una palabra repetida o en plural varias veces en el mismo ítem cuenta una vez", () => {
    expect(semilla().coincidenciasPorItem(["zapatilla zapatillas ZAPATILLA zapatilla."])).toEqual([
      { item: 0, palabra: "zapatilla", categoria: "calzado-ropa" },
    ]);
  });

  it("sin glosas o sin coincidencias devuelve un arreglo vacío", () => {
    expect(semilla().coincidenciasPorItem([])).toEqual([]);
    expect(semilla().coincidenciasPorItem(["", "cemento"])).toEqual([]);
  });

  it("un ítem vacío entre dos con coincidencia conserva los índices", () => {
    expect(semilla().coincidenciasPorItem(["zapatilla", "", "polo"]).map((c) => c.item)).toEqual([0, 2]);
  });

  it("palabra completa o plural simple, no prefijos: «zapatillero» y «polonia» no coinciden; «polos» y «jeanes» sí", () => {
    const d = semilla();
    expect(palabras(d, "zapatillero")).toEqual([]);
    expect(palabras(d, "polonia")).toEqual([]);
    expect(palabras(d, "polos")).toEqual(["polo"]);
    expect(palabras(d, "jeanes")).toEqual(["jean"]);
  });

  it("una abreviatura de 3 letras no coincide («zap.») y una de 4 o más sí («zapa.»)", () => {
    const d = semilla();
    expect(palabras(d, "zap.")).toEqual([]);
    expect(palabras(d, "zapa.")).toEqual(["zapatilla", "zapato"]);
  });

  it("el diccionario con 2.000 palabras propias responde por índice: una glosa de 1 MB no se cuelga", () => {
    const grande = DiccionarioGlosas.desde([
      ...entradasSemilla(),
      ...Array.from({ length: 2000 }, (_, i) => ({ categoria: "entretenimiento", palabras: [`prop${i.toString(36).padStart(4, "0")}`] })),
    ]);
    const glosa = `${"relleno ".repeat(120_000)}zapatilla`;
    expect(grande.coincidenciasPorItem([glosa]).map((c) => c.palabra)).toEqual(["zapatilla"]);
  });
});

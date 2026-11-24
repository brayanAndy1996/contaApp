// Spec 027 · T16 (rojo; corrección de H-027-1-1, decisión del usuario 2026-11-23): el plural simple se acepta EN AMBOS SENTIDOS. La
// coincidencia de 011 (R-4, U-4) solo aceptaba el plural del lado de la GLOSA (token = palabra + s/es); ahora una palabra del diccionario
// guardada en plural («audifonos») marca también la glosa en singular («AUDÍFONO») y al revés. Plural simple = +s o +es, sin raíces
// («lapiz» no es «lapices»), sin prefijos y con el singular de 3 letras como mínimo (el mínimo de una palabra de diccionario).
// Aplica igual a palabras (globales o propias, que llegan como entradas) y a frases de excepción. `buscar` (011) y `coincidenciasPorItem`
// deben coincidir en esto.
import { describe, expect, it } from "vitest";
import { DiccionarioGlosas } from "./diccionario";

const con = (palabra: string, excepciones: string[] = []) =>
  DiccionarioGlosas.desde([{ categoria: "entretenimiento", palabras: [palabra], excepciones }]);
const palabras = (d: DiccionarioGlosas, ...glosas: string[]): string[] => d.coincidenciasPorItem(glosas).map((c) => c.palabra);

describe("T16 · plural en ambos sentidos: palabra guardada → glosa (H-027-1-1)", () => {
  // [palabra guardada, glosa]. Pasan hoy (con 011) las de palabra guardada en singular, las iguales y las de glosa con punto («audifono.»,
  // que cuenta como abreviatura prefijo de la palabra); fallan las de glosa sin punto en la otra forma.
  it.each([
    ["audifonos", "AUDÍFONO INALAMBRICO"],
    ["audifonos", "Audífono Sony"],
    ["audifonos", "audifono."],
    ["audifonos", "AUDIFONO.38 NEGRO"],
    ["audifonos", "audifonos"],
    ["audifonos", "AUDÍFONOS JBL"],
    ["audifono", "AUDIFONOS JBL"],
    ["audifono", "AUDÍFONO JBL"],
    ["pantalones", "PANTALON JEAN"],
    ["pantalones", "pantalon."],
    ["pantalon", "PANTALONES JEAN"],
    ["zapatillas", "ZAPATILLA URBANA"],
    ["zapatilla", "ZAPATILLAS URBANAS"],
    ["gases", "GAS PROPANO"],
  ])("%j guardada coincide con %j", (guardada, glosa) => {
    expect(palabras(con(guardada), glosa)).toEqual([guardada]);
  });

  it("la palabra que se informa es la del diccionario (la forma guardada), no la que trae la glosa", () => {
    const d = DiccionarioGlosas.desde([{ categoria: "juguetes", palabras: ["patinetas"] }]);
    expect(d.coincidenciasPorItem(["PATINETA ELECTRICA", "", "patinetas"])).toEqual([
      { item: 0, palabra: "patinetas", categoria: "juguetes" },
      { item: 2, palabra: "patinetas", categoria: "juguetes" },
    ]);
  });

  it("`buscar` (011) coincide igual en ambos sentidos", () => {
    expect(con("audifonos").buscar(["AUDÍFONO INALAMBRICO"])).toEqual({ palabra: "audifonos", categoria: "entretenimiento" });
    expect(con("audifono").buscar(["AUDIFONOS JBL"])).toEqual({ palabra: "audifono", categoria: "entretenimiento" });
    expect(con("pantalones").buscar(["compra de pantalon"])?.palabra).toBe("pantalones");
  });

  it("la abreviatura con punto sigue siendo prefijo de la palabra guardada, en cualquiera de sus formas", () => {
    expect(palabras(con("audifonos"), "audif. jbl")).toEqual(["audifonos"]);
    expect(palabras(con("audifono"), "audif. jbl")).toEqual(["audifono"]);
  });

  it("una glosa con varios ítems: cada uno con su forma", () => {
    expect(
      con("audifonos")
        .coincidenciasPorItem(["audifono jbl", "cable usb", "AUDIFONOS sony"])
        .map((c) => c.item),
    ).toEqual([0, 2]);
  });
});

describe("T16 · el plural simple no se amplía: sin raíces, sin prefijos, singular de 3 letras como mínimo", () => {
  it.each([
    ["audifonos", "audifonera"],
    ["audifonos", "audifon"],
    ["audifonos", "audi"],
    ["audifono", "audifonero"],
    ["pantalones", "pantalonera"],
    ["pantalones", "pantal"],
    ["zapatillas", "zapatillero"],
    ["polos", "polonia"],
    ["polos", "pol"],
    ["lapices", "lapiz"], // «-z → -ces» no es plural simple
    ["lapiz", "lapices"],
    ["gas", "ga"], // el singular derivado tendría 2 letras (< 3, el mínimo de una palabra de diccionario)
    ["bus", "bu"],
    ["mes", "m"],
  ])("%j guardada NO coincide con %j", (guardada, glosa) => {
    expect(palabras(con(guardada), glosa)).toEqual([]);
    expect(con(guardada).buscar([glosa])).toBeNull();
  });

  it("una abreviatura de 3 letras con punto sigue sin coincidir con la forma plural («aud.») y la de 4 sí («audi.»)", () => {
    expect(palabras(con("audifonos"), "aud.")).toEqual([]);
    expect(palabras(con("audifonos"), "audi.")).toEqual(["audifonos"]);
  });
});

describe("T16 · plural en ambos sentidos en las frases de excepción (R-4, U-4)", () => {
  it("la excepción guardada en plural anula la glosa en singular y al revés", () => {
    expect(palabras(con("audifono", ["cables"]), "audifono con cable")).toEqual([]);
    expect(palabras(con("audifono", ["cable"]), "audifono con cables")).toEqual([]);
    expect(palabras(con("audifono", ["seguridades"]), "audifono de SEGURIDAD")).toEqual([]);
    expect(palabras(con("audifono", ["seguridad"]), "audifono de seguridades")).toEqual([]);
  });

  it("en una frase de 3 palabras cada token acepta su otra forma («punta de aceros» ↔ «punta de acero»)", () => {
    const d = DiccionarioGlosas.desde([{ categoria: "calzado-ropa", palabras: ["bota"], excepciones: ["puntas de aceros"] }]);
    expect(palabras(d, "bota punta de acero")).toEqual([]);
    expect(palabras(d, "BOTA PUNTAS DE ACEROS")).toEqual([]);
    const e = DiccionarioGlosas.desde([{ categoria: "calzado-ropa", palabras: ["bota"], excepciones: ["punta de acero"] }]);
    expect(palabras(e, "bota puntas de aceros")).toEqual([]);
  });

  it("sin raíces ni prefijos en las excepciones: «guantes» no anula «guantera», «seguridad» no anula «seguridadX»", () => {
    expect(palabras(con("audifono", ["guantes"]), "audifono guantera")).toEqual(["audifono"]);
    expect(palabras(con("audifono", ["guantes"]), "audifono guant")).toEqual(["audifono"]);
    expect(palabras(con("audifono", ["lapiz"]), "audifono lapices")).toEqual(["audifono"]);
  });

  it("la excepción no cruza ítems ni palabras: la forma plural de otra excepción no anula", () => {
    expect(con("audifono", ["cable"]).coincidenciasPorItem(["audifono jbl", "cables"]).map((c) => c.item)).toEqual([0]);
  });
});

describe("T16 · el diccionario con las dos formas de una palabra (datos viejos, sin migrar)", () => {
  const ambas = DiccionarioGlosas.desde([
    { categoria: "entretenimiento", palabras: ["audifonos"] },
    { categoria: "juguetes", palabras: ["audifono"] },
  ]);

  it("es determinista: el orden de las entradas no cambia el resultado y toda coincidencia es de ese ítem", () => {
    const al_reves = DiccionarioGlosas.desde([
      { categoria: "juguetes", palabras: ["audifono"] },
      { categoria: "entretenimiento", palabras: ["audifonos"] },
    ]);
    for (const glosa of ["AUDIFONO JBL", "AUDIFONOS JBL"]) {
      expect(al_reves.coincidenciasPorItem([glosa])).toEqual(ambas.coincidenciasPorItem([glosa]));
      expect(ambas.coincidenciasPorItem([glosa]).length, glosa).toBeGreaterThan(0);
      for (const c of ambas.coincidenciasPorItem([glosa])) expect(c.item).toBe(0);
    }
  });
});

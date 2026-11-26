// Spec 027 · T20 (H-027-2-7): coincidencias por ítem lineales. Ítems con muchas palabras distintas (más de 16: se pasa de buscar en la
// lista a marcar por posición), con la otra forma de una ya hallada, con abreviaturas que abren un tramo del orden de código y con el
// mismo contenido en varios ítems (la marca de un ítem no esconde nada en el siguiente). Caso de error: entradas inválidas.
import { describe, expect, it } from "vitest";
import { DiccionarioGlosas } from "./diccionario";

const LETRAS = [..."abcdfghijklmnopqrtuv"]; // sin «e» ni «s»: ninguna es la otra forma de otra
const PALABRAS = LETRAS.map((l) => `clave${l}`);
const d = DiccionarioGlosas.desde([{ categoria: "juguetes", palabras: PALABRAS }]);
const palabrasDe = (glosas: string[]) => d.coincidenciasPorItem(glosas).map((c) => `${c.item}:${c.palabra}`);

describe("coincidenciasPorItem con muchas palabras en un ítem (T20, H-027-2-7)", () => {
  it("16 palabras, la otra forma de la primera (paso a la marca con una ya hallada), más palabras y repetidas: cada una una vez y en orden", () => {
    const primeras = PALABRAS.slice(0, 16);
    const glosa = [...primeras, `${PALABRAS[0]}s`, ...PALABRAS.slice(16), `${PALABRAS[1]}s`, ...PALABRAS, "CLAV."].join(" ");
    const esperado = (item: number) => [...PALABRAS].sort().map((p) => `${item}:${p}`);
    expect(palabrasDe([glosa, glosa])).toEqual([...esperado(0), ...esperado(1)]);
  });

  it("abreviatura tras otros hallazgos: tramo corto y tramo largo pasan por la búsqueda sin repetir", () => {
    const corta = DiccionarioGlosas.desde([
      { categoria: "juguetes", palabras: [...PALABRAS, "pelota", "peluche"] },
    ]);
    const c = corta.coincidenciasPorItem(["PELOTA PELU. CLAVE.", "CLAVEA CLAVE. PELO."]).map((x) => `${x.item}:${x.palabra}`);
    expect(c).toEqual([
      ...[...PALABRAS, "pelota", "peluche"].sort().map((p) => `0:${p}`),
      ...[...PALABRAS, "pelota"].sort().map((p) => `1:${p}`),
    ]);
  });

  it("error: una palabra o una frase de excepción fuera de la gramática es RangeError", () => {
    expect(() => DiccionarioGlosas.desde([{ categoria: "juguetes", palabras: ["ab"] }])).toThrow(RangeError);
    expect(() => DiccionarioGlosas.desde([{ categoria: "juguetes", palabras: ["clave"], excepciones: ["una frase de cuatro"] }])).toThrow(
      RangeError,
    );
  });
});

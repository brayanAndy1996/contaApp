// Spec 027 · T19 (rojo; correcciones de la ronda adversarial 2, dominio). Una prueba normal por hallazgo y por decisión del usuario del
// 2026-11-23, además de las de T18 (`ronda2.adv.spec.ts`, que siguen siendo la referencia de cada H-027-2-n). Lo que fijan, por hallazgo:
//   H-027-2-2  con las dos formas guardadas de una palabra (datos anteriores a 0071) gana la menor (D-8) también para S3, sea cual sea la forma
//              que decide: ni la categoría de la perdedora suma S3 ni la ajustada por el cliente (`quitadas`) la cuenta.
//   H-027-2-4  una frase de excepción abreviada con punto anula con la misma regla que una palabra (prefijo ≥ 4 letras CON punto), sin pasarse.
//   H-027-2-5  «Aprender» no propone la otra forma de una unidad o de una palabra vacía.
//   H-027-2-6  los caracteres de formato invisibles (Cf) dentro de una palabra no la parten (toca `tokensDeGlosa` de 011): ni en glosas, ni en
//              abreviaturas, ni en la frase de excepción.
//   H-027-2-7  tope de tiempo con abreviaturas que casan con muchas palabras (las de T18 fijan 250 ms para una glosa y 800 ms para 100×20;
//              aquí, 1.000 ítems en una compra, y el tokenizador con 200.000 invisibles).
// Las que pasan hoy (bordes, regresiones) lo dicen en su nombre.
import { describe, expect, it } from "vitest";
import { PROV, SEMILLA_GLOBAL, contextoNeutro } from "../../tests/ayudas/gastos";
import type { PalabraPlana } from "../../tests/ayudas/gastos";
import { DiccionarioGlosas } from "../texto/diccionario";
import { tokensDeGlosa } from "../texto/normalizar";
import { crearDiccionarioEfectivo } from "./contexto";
import { puntuarGastoPersonal } from "./puntaje";
import { proponerTerminos } from "./terminos";

const propia = (palabra: string, categoria: string, ...excepciones: string[]): PalabraPlana => ({
  palabra,
  categoria,
  excepciones,
  activa: true,
});
const globalPlana = (palabra: string, categoria: string, ...excepciones: string[]): PalabraPlana => ({
  palabra,
  categoria,
  excepciones,
  activa: true,
});
const efectivo = (...propias: PalabraPlana[]) => crearDiccionarioEfectivo({ globales: SEMILLA_GLOBAL, desactivadas: [], propias });
const porItem = (d: DiccionarioGlosas, glosas: string[]) =>
  d.coincidenciasPorItem(glosas).map((c) => `${c.item}:${c.categoria}`);
const puntuar = (diccionario: DiccionarioGlosas, glosas: string[], extra: Parameters<typeof contextoNeutro>[0] = {}) =>
  puntuarGastoPersonal(
    { glosas, fechaEmision: "2026-03-11", proveedor: { ...PROV }, esNuevo: false },
    contextoNeutro({ diccionario, ...extra }),
  );

describe("T19 · H-027-2-2: con las dos formas guardadas gana la menor, y solo ella decide S1 y S3 (D-8)", () => {
  it("categoría quitada por el ajuste del cliente (sin CIIU): la de la forma perdedora no suma S3", () => {
    // Global «zapatilla» (calzado-ropa) + propia «zapatillas» (juguetes, quitada para el cliente). Gana «zapatilla»: no hay S3.
    const r = puntuar(efectivo(propia("zapatillas", "juguetes")), ["ZAPATILLAS URBANAS T42"], {
      categoriasCliente: { permitidas: [], quitadas: ["juguetes"] },
    });
    expect(r).toMatchObject({ palabra: "zapatilla", categoria: "calzado-ropa" });
    expect(r.senales.map((s) => s.codigo)).toEqual(["S1"]);
    expect(r.puntaje).toBe(3);
  });

  it("sin glosa de la otra forma, nada cambia: «ZAPATILLA URBANA» con las dos formas da S1 de la menor y el mismo puntaje que con una sola", () => {
    const sola = puntuar(efectivo(), ["ZAPATILLA URBANA T42"], { ciiuCliente: "4771", categoriasCliente: { permitidas: ["calzado-ropa"], quitadas: [] } });
    const dos = puntuar(efectivo(propia("zapatillas", "juguetes")), ["ZAPATILLA URBANA T42"], {
      ciiuCliente: "4771",
      categoriasCliente: { permitidas: ["calzado-ropa"], quitadas: [] },
    });
    expect(dos.puntaje).toBe(sola.puntaje);
    expect(dos.senales.map((s) => s.codigo)).toEqual(sola.senales.map((s) => s.codigo));
  });

  it("regresión: cuando la menor es la no permitida, S3 sí cuenta con SU categoría (no se pierde por la categoría permitida de la perdedora)", () => {
    // Global «lentes» (calzado-ropa, permitida) + propia «lente» (juguetes, no permitida para 4771): «lente» < «lentes», decide juguetes.
    const diccionario = crearDiccionarioEfectivo({
      globales: [globalPlana("lentes", "calzado-ropa")],
      desactivadas: [],
      propias: [propia("lente", "juguetes")],
    });
    const r = puntuar(diccionario, ["LENTE GRAN ANGULAR"], { ciiuCliente: "4771", categoriasCliente: { permitidas: ["calzado-ropa"], quitadas: [] } });
    expect(r).toMatchObject({ palabra: "lente", categoria: "juguetes" });
    expect(r.senales.map((s) => s.codigo)).toEqual(["S1", "S3"]);
    expect(r.puntaje).toBe(5);
  });

  it("dos palabras DISTINTAS en el mismo ítem siguen sumando cada una (no se pierde S3 de una palabra que no es la otra forma)", () => {
    // «zapatilla» (calzado-ropa, permitida) y «perfume» (cuidado-personal, quitada): palabras distintas, S3 por «perfume».
    const r = puntuar(efectivo(), ["ZAPATILLA CON PERFUME"], { categoriasCliente: { permitidas: [], quitadas: ["cuidado-personal"] } });
    expect(r.senales.map((s) => s.codigo)).toEqual(["S1", "S3"]);
  });
});

describe("T19 · H-027-2-4: la frase de excepción abreviada anula con la misma regla que la palabra (decisión 2026-11-23)", () => {
  it("«SEGUR.» anula «seguridad» en cualquiera de las palabras de la frase y también en la de varias palabras («punta de acero»)", () => {
    expect(porItem(efectivo(), ["ZAPATILLA DE SEGUR. T-42"])).toEqual([]);
    expect(porItem(efectivo(), ["BOTA PUNTA DE ACER."])).toEqual([]);
    expect(porItem(efectivo(), ["ZAPATO PUNT. DE ACERO"])).toEqual([]);
    expect(porItem(efectivo(), ["CASACA REFLECT. NARANJA"])).toEqual([]);
  });

  it("la excepción de una propia con varias palabras también anula abreviada, y en plural o singular (D-8)", () => {
    const d = efectivo(propia("mochila", "utiles-escolares", "fumigadora", "tela impermeable"));
    expect(porItem(d, ["MOCHILA FUMIGAD. 20L", "MOCHILA TELA IMPERM.", "MOCHILAS TELAS IMPERMEABLES"])).toEqual([]);
    expect(porItem(d, ["MOCHILA ESCOLAR"])).toEqual(["0:utiles-escolares"]);
  });

  it("regresión: sin pasarse. Menos de 4 letras, sin punto o que no es prefijo de la excepción NO anulan", () => {
    // Igual que una palabra: «zapa.» (4) es abreviatura válida; «seg.» (3) no; «segur» sin punto no es «seguridad»; «segurx.» no es prefijo.
    expect(porItem(efectivo(), ["ZAPATILLA DE SEG. T-42"])).toEqual(["0:calzado-ropa"]);
    expect(porItem(efectivo(), ["ZAPATILLA DE SEGUR T-42"])).toEqual(["0:calzado-ropa"]);
    expect(porItem(efectivo(), ["ZAPATILLA DE SEGURX. T-42"])).toEqual(["0:calzado-ropa"]);
    expect(porItem(efectivo(), ["BOTA DE PUNTA DE AC."])).toEqual(["0:calzado-ropa"]);
  });

  it("regresión: la abreviatura de la excepción anula solo en su ítem (no en el siguiente)", () => {
    expect(porItem(efectivo(), ["ZAPATILLA SEGUR.", "ZAPATILLA URBANA"])).toEqual(["1:calzado-ropa"]);
  });
});

describe("T19 · H-027-2-5: «Aprender» no propone la otra forma de unidades ni de palabras vacías (D-8)", () => {
  it("«cientos», «millares», «mililitro», «modelos», «marcas», «tipos» y otras formas de las unidades: no se proponen", () => {
    expect(proponerTerminos(["CIENTOS MILLARES MILILITRO", "MODELOS MARCAS TIPOS", "GALS DOCS PAQS"], efectivo())).toEqual([]);
  });

  it("control: lo que no es la otra forma de una de las listas sí se propone, en orden", () => {
    expect(proponerTerminos(["MARCAS ROPAS MODELOS CAMISETAS TIPOS"], efectivo())).toEqual(["ropas", "camisetas"]);
  });
});

describe("T19 · H-027-2-6: caracteres de formato invisibles no parten una palabra (R-4)", () => {
  // Cf que se cuelan al copiar de un PDF o de una página: guion suave, ancho cero, marcas bidi, juntador de palabras, BOM, operadores invisibles.
  const INVISIBLES: [string, string][] = [
    ["U+00AD guion suave", "­"],
    ["U+200B espacio de ancho cero", "​"],
    ["U+200C no-unión de ancho cero", "‌"],
    ["U+200D unión de ancho cero", "‍"],
    ["U+200E marca izquierda-derecha", "‎"],
    ["U+200F marca derecha-izquierda", "‏"],
    ["U+202A embebido izquierda-derecha", "‪"],
    ["U+202B embebido derecha-izquierda", "‫"],
    ["U+202C fin de formato direccional", "‬"],
    ["U+202D anulación izquierda-derecha", "‭"],
    ["U+202E anulación derecha-izquierda", "‮"],
    ["U+2060 juntador de palabras", "⁠"],
    ["U+2061 aplicación de función", "⁡"],
    ["U+2064 más invisible", "⁤"],
    ["U+2066 aislamiento izquierda-derecha", "⁦"],
    ["U+2069 fin de aislamiento", "⁩"],
    ["U+061C marca de letra árabe", "؜"],
    ["U+FEFF marca de orden de bytes", "﻿"],
  ];

  it.each(INVISIBLES)("%s: el tokenizador de 011 la ignora dentro de la palabra", (_n, c) => {
    expect(tokensDeGlosa(`ZAPA${c}TILLAS URBANAS`)).toEqual(["zapatillas", "urbanas"]);
    expect(tokensDeGlosa(`${c}ZAPATILLAS${c}`)).toEqual(["zapatillas"]);
  });

  it.each(INVISIBLES)("%s: la palabra con el carácter en medio coincide y marca", (_n, c) => {
    expect(porItem(efectivo(), [`ZAPA${c}TILLA URBANA`, `ZA${c}PA${c}TI${c}LLAS`])).toEqual(["0:calzado-ropa", "1:calzado-ropa"]);
  });

  it("también parten la abreviatura con punto y la frase de excepción: «ZAPAT­.» marca y «SEGU​RIDAD» anula", () => {
    expect(porItem(efectivo(), ["ZAPAT­. DEPORTIVA", "ZAPA⁠T. DEP."])).toEqual(["0:calzado-ropa", "1:calzado-ropa"]);
    expect(porItem(efectivo(), ["ZAPATILLA DE SEGU​RIDAD", "BOTA PUNTA DE AC­ERO"])).toEqual([]);
  });

  it("regresión: un espacio (también el de no separación) sigue separando palabras y un invisible solo no crea token", () => {
    expect(tokensDeGlosa("ZAPATILLAS URBANAS")).toEqual(["zapatillas", "urbanas"]);
    expect(tokensDeGlosa("ZAPATILLAS URBANAS")).toEqual(["zapatillas", "urbanas"]);
    expect(tokensDeGlosa("​­⁦")).toEqual([]);
    expect(porItem(efectivo(), ["ZAPA TILLAS URBANAS"])).toEqual([]);
  });

  it("regresión: 200.000 invisibles seguidos se tokenizan en tiempo lineal (menos de 500 ms)", () => {
    const a = Date.now();
    expect(tokensDeGlosa(`ZAPA${"​".repeat(200_000)}TILLAS`).length).toBeLessThanOrEqual(2);
    expect(Date.now() - a).toBeLessThan(500);
  });
});

describe("T19 · H-027-2-7: con una compra hostil el tiempo no se dispara (R-10)", () => {
  const letras = (n: number): string => {
    let r = "";
    let x = n;
    do {
      r = String.fromCharCode(97 + (x % 26)) + r;
      x = Math.floor(x / 26);
    } while (x > 0);
    return r;
  };
  const d = efectivo(...Array.from({ length: 2_000 }, (_, i) => propia(`prod${letras(i).padStart(4, "a")}`, "entretenimiento")));

  it("una compra de 1.000 ítems «PROD.» con 2.000 palabras (2 millones de coincidencias) se puntúa en menos de 600 ms y da S1 con el tope", { timeout: 60_000 }, () => {
    const glosas = Array.from({ length: 1_000 }, (_, i) => `PROD. LIMPIEZA ${i}`);
    const a = Date.now();
    const r = puntuar(d, glosas);
    expect(Date.now() - a).toBeLessThan(600);
    expect(r.senales[0]).toMatchObject({ codigo: "S1", puntos: 6 });
    expect(r.palabra).toBe("prodaaaa");
  });
});

import { describe, expect, it } from "vitest";
import * as shared from "../index.js";

// Spec 027 · T2 (rojo). Cuerpos de las solicitudes del diccionario de gastos no deducibles (spec 027 R-4, R-7, R-11, R-13; D-3; plan 027, Contratos: shared).
// Contrato fijado por estas pruebas (packages/shared/src/gastos/esquemas.ts, exportado por gastos/index.ts y por src/index.ts). Todos los objetos
// de entrada son `.strict()` (clave extra, p. ej. tenantId o clienteId, se rechaza); ningún número viaja como cadena ni al revés.
//  - CATEGORIAS_GND = las 6 categorías, en este orden (shared no depende de domain; la lista se repite aquí y la guarda esta prueba):
//    calzado-ropa, juguetes, entretenimiento, alimentos-personales, cuidado-personal, utiles-escolares.
//  - palabraSchema = UNA palabra de letras y dígitos (con tildes y ñ: el backend normaliza con el dominio, el esquema NO transforma),
//    de 3 a 40 caracteres. Sin espacios, signos, guiones ni espacios al borde (no hay trim).
//  - excepcionesSchema = lista de hasta 5 frases (puede ser vacía); cada frase, de 1 a 3 palabras de letras y dígitos separadas por un espacio.
//  - agregarPalabraSchema = {palabra, categoria, excepciones?}; palabraGlobalSchema = el mismo cuerpo (super-admin).
//  - estadoPalabraSchema = {activa: boolean, version: entero >= 1}; estadoGlobalSchema = {activa: boolean}.
//  - umbralSchema = {umbral: entero 1..20, version: entero >= 0 (0 = sin fila: umbral por defecto 3)}.
//  - categoriasClienteSchema = {permitidas, quitadas, version >= 0}: subconjuntos de CATEGORIAS_GND y DISJUNTOS.
//  - aprenderSchema = {terminos: [{termino, categoria}] de 1 a 10}; termino sigue la gramática de palabraSchema; categoria obligatoria.
//  - editarGlobalSchema = {categoria, excepciones, activa, version >= 1} (todas obligatorias).
// Los esquemas se piden por nombre: si el export no existe, la prueba falla con «no implementado», no al cargar el archivo.
interface Esquema {
  safeParse: (v: unknown) => { success: boolean; data?: unknown };
}
const esquema = (nombre: string): Esquema => {
  const s = (shared as Record<string, unknown>)[nombre] as Esquema | undefined;
  if (s === undefined) throw new Error(`no implementado: @contapp/shared no exporta ${nombre}`);
  return s;
};
const ok = (nombre: string, v: unknown) => esquema(nombre).safeParse(v).success;
const datos = (nombre: string, v: unknown) => {
  const r = esquema(nombre).safeParse(v);
  expect(r.success).toBe(true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return r.data as Record<string, any>;
};

const CATEGORIAS = ["calzado-ropa", "juguetes", "entretenimiento", "alimentos-personales", "cuidado-personal", "utiles-escolares"];

describe("exportaciones de @contapp/shared para gastos no deducibles (027)", () => {
  it.each([
    "palabraSchema",
    "excepcionesSchema",
    "agregarPalabraSchema",
    "estadoPalabraSchema",
    "estadoGlobalSchema",
    "umbralSchema",
    "categoriasClienteSchema",
    "aprenderSchema",
    "palabraGlobalSchema",
    "editarGlobalSchema",
  ])("exporta %s", (nombre) => {
    expect((shared as Record<string, unknown>)[nombre]).toBeDefined();
  });
  it("CATEGORIAS_GND son las 6 categorías, en orden", () => {
    expect((shared as Record<string, unknown>).CATEGORIAS_GND).toEqual(CATEGORIAS);
  });
});

describe("palabraSchema (R-4)", () => {
  const S = "palabraSchema";
  it.each(["zapatilla", "abc", "a".repeat(40), "ZAPATILLA", "muñeca", "pantalón", "ñoño", "xbox360", "123", "Camisa"])("acepta %j y lo devuelve tal cual", (p) => {
    expect(esquema(S).safeParse(p).data).toBe(p);
  });
  it.each([
    ["2 letras", "ab"],
    ["41 letras", "a".repeat(41)],
    ["vacía", ""],
    ["con espacio en medio", "zapatilla roja"],
    ["con espacio antes", " zapato"],
    ["con espacio después", "zapato "],
    ["solo espacios", "   "],
    ["con guion", "polo-azul"],
    ["con punto final", "zapatilla."],
    ["con signo", "zapa$illa"],
    ["con etiqueta", "<script>"],
    ["con salto de línea", "zapato\n"],
    ["con tabulación", "za\tpato"],
    ["con barra", "a/b/c"],
    ["número", 123],
    ["null", null],
    ["undefined", undefined],
    ["lista", ["zapato"]],
    ["objeto", { palabra: "zapato" }],
  ])("rechaza %s", (_c, p) => {
    expect(ok(S, p)).toBe(false);
  });
});

describe("excepcionesSchema (R-4)", () => {
  const S = "excepcionesSchema";
  it.each([
    [[]],
    [["seguridad"]],
    [["seguridad", "punta de acero"]],
    [["a tierra"]],
    [["a", "b c", "d e f", "seguridad", "jebe"]],
    [["Seguridad", "PUNTA DE ACERO"]],
    [["reflectiva"]],
  ])("acepta %j", (e) => {
    expect(ok(S, e)).toBe(true);
  });
  it.each([
    ["6 frases", ["a1", "b2", "c3", "d4", "e5", "f6"]],
    ["una frase de 4 palabras", ["punta de acero fino"]],
    ["frase vacía", [""]],
    ["frase de espacios", ["   "]],
    ["frase con espacio al borde", [" seguridad"]],
    ["frase con signo", ["seguridad!"]],
    ["frase con etiqueta", ["<script>"]],
    ["frase número", [1]],
    ["frase null", [null]],
    ["una cadena en vez de lista", "seguridad"],
    ["null", null],
    ["objeto", { 0: "seguridad" }],
  ])("rechaza %s", (_c, e) => {
    expect(ok(S, e)).toBe(false);
  });
});

describe("agregarPalabraSchema y palabraGlobalSchema (R-4, R-7)", () => {
  it.each(["agregarPalabraSchema", "palabraGlobalSchema"])("%s acepta {palabra, categoria} y {palabra, categoria, excepciones}", (S) => {
    expect(datos(S, { palabra: "zapatilla", categoria: "calzado-ropa" })).toEqual({ palabra: "zapatilla", categoria: "calzado-ropa" });
    expect(datos(S, { palabra: "polo", categoria: "calzado-ropa", excepciones: ["a tierra"] })).toEqual({ palabra: "polo", categoria: "calzado-ropa", excepciones: ["a tierra"] });
  });
  it.each(["agregarPalabraSchema", "palabraGlobalSchema"])("%s acepta cada una de las 6 categorías", (S) => {
    for (const categoria of CATEGORIAS) expect(ok(S, { palabra: "algo", categoria })).toBe(true);
  });
  it.each(["agregarPalabraSchema", "palabraGlobalSchema"])("%s rechaza categorías fuera de las 6", (S) => {
    for (const categoria of ["personal", "Juguetes", "juguetes ", "", "calzado", null, 1, undefined, ["juguetes"]]) {
      expect(ok(S, { palabra: "algo", categoria }), String(categoria)).toBe(false);
    }
  });
  it.each(["agregarPalabraSchema", "palabraGlobalSchema"])("%s exige palabra y categoria, y valida la palabra y las excepciones", (S) => {
    expect(ok(S, { categoria: "juguetes" })).toBe(false);
    expect(ok(S, { palabra: "algo" })).toBe(false);
    expect(ok(S, { palabra: "dos palabras", categoria: "juguetes" })).toBe(false);
    expect(ok(S, { palabra: "ab", categoria: "juguetes" })).toBe(false);
    expect(ok(S, { palabra: "a".repeat(41), categoria: "juguetes" })).toBe(false);
    expect(ok(S, { palabra: "algo", categoria: "juguetes", excepciones: ["1 2 3 4"] })).toBe(false);
    expect(ok(S, { palabra: "algo", categoria: "juguetes", excepciones: ["a1", "b2", "c3", "d4", "e5", "f6"] })).toBe(false);
    expect(ok(S, { palabra: "algo", categoria: "juguetes", excepciones: null })).toBe(false);
  });
  it.each(["agregarPalabraSchema", "palabraGlobalSchema"])("%s es estricto: rechaza tenantId, usuarioId, origen, activa, version, id y __proto__", (S) => {
    const base = { palabra: "algo", categoria: "juguetes" };
    for (const extra of [{ tenantId: "x" }, { usuarioId: "x" }, { origen: "manual" }, { activa: true }, { version: 1 }, { id: "x" }, { constructor: 1 }]) {
      expect(ok(S, { ...base, ...extra }), JSON.stringify(extra)).toBe(false);
    }
    expect(ok(S, JSON.parse('{"palabra":"algo","categoria":"juguetes","__proto__":{"x":1}}'))).toBe(false);
  });
  it.each(["agregarPalabraSchema", "palabraGlobalSchema"])("%s rechaza el cuerpo %j", (S) => {
    for (const cuerpo of [null, undefined, "zapato", 1, [], [{ palabra: "algo", categoria: "juguetes" }]]) expect(ok(S, cuerpo)).toBe(false);
  });
});

describe("estadoPalabraSchema y estadoGlobalSchema (R-7, R-8)", () => {
  it("estadoPalabraSchema acepta {activa, version}", () => {
    expect(datos("estadoPalabraSchema", { activa: false, version: 1 })).toEqual({ activa: false, version: 1 });
    expect(ok("estadoPalabraSchema", { activa: true, version: 37 })).toBe(true);
  });
  it.each([
    ["sin version", { activa: true }],
    ["sin activa", { version: 1 }],
    ["activa como cadena", { activa: "true", version: 1 }],
    ["activa como número", { activa: 1, version: 1 }],
    ["version decimal", { activa: true, version: 1.5 }],
    ["version negativa", { activa: true, version: -1 }],
    ["version como cadena", { activa: true, version: "1" }],
    ["clave extra palabra", { activa: true, version: 1, palabra: "x" }],
    ["clave extra categoria", { activa: true, version: 1, categoria: "juguetes" }],
    ["vacío", {}],
    ["null", null],
  ])("estadoPalabraSchema rechaza %s", (_c, v) => {
    expect(ok("estadoPalabraSchema", v)).toBe(false);
  });
  it("estadoGlobalSchema acepta {activa} (desactivar o reactivar la global para el estudio)", () => {
    expect(datos("estadoGlobalSchema", { activa: true })).toEqual({ activa: true });
    expect(ok("estadoGlobalSchema", { activa: false })).toBe(true);
  });
  it.each([
    ["vacío", {}],
    ["activa como cadena", { activa: "false" }],
    ["activa null", { activa: null }],
    ["con version (la desactivación del estudio no versiona)", { activa: true, version: 1 }],
    ["clave extra", { activa: true, estudio: "x" }],
    ["null", null],
  ])("estadoGlobalSchema rechaza %s", (_c, v) => {
    expect(ok("estadoGlobalSchema", v)).toBe(false);
  });
});

describe("umbralSchema (R-11, U-6)", () => {
  const S = "umbralSchema";
  it.each([1, 3, 10, 20])("acepta el umbral %j", (umbral) => {
    expect(datos(S, { umbral, version: 0 })).toEqual({ umbral, version: 0 });
  });
  it.each([
    ["0", 0],
    ["21", 21],
    ["-1", -1],
    ["3.5", 3.5],
    ["«3» como cadena", "3"],
    ["null", null],
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["lista", [3]],
  ])("rechaza el umbral %s", (_c, umbral) => {
    expect(ok(S, { umbral, version: 0 })).toBe(false);
  });
  it("la versión es entero >= 0 y obligatoria", () => {
    expect(ok(S, { umbral: 3 })).toBe(false);
    expect(ok(S, { umbral: 3, version: -1 })).toBe(false);
    expect(ok(S, { umbral: 3, version: 0.5 })).toBe(false);
    expect(ok(S, { umbral: 3, version: "1" })).toBe(false);
    expect(ok(S, { umbral: 3, version: 7 })).toBe(true);
  });
  it("es estricto y exige el umbral", () => {
    expect(ok(S, { version: 0 })).toBe(false);
    expect(ok(S, { umbral: 3, version: 0, tenantId: "x" })).toBe(false);
    expect(ok(S, null)).toBe(false);
  });
});

describe("categoriasClienteSchema (R-13, U-14)", () => {
  const S = "categoriasClienteSchema";
  it("acepta permitidas y quitadas disjuntas", () => {
    const v = { permitidas: ["calzado-ropa", "juguetes"], quitadas: ["cuidado-personal"], version: 2 };
    expect(datos(S, v)).toEqual(v);
  });
  it("acepta ambas listas vacías (sin ajuste) y versión 0", () => {
    expect(ok(S, { permitidas: [], quitadas: [], version: 0 })).toBe(true);
  });
  it("acepta las 6 en una sola lista y la otra vacía", () => {
    expect(ok(S, { permitidas: CATEGORIAS, quitadas: [], version: 1 })).toBe(true);
    expect(ok(S, { permitidas: [], quitadas: CATEGORIAS, version: 1 })).toBe(true);
  });
  it("rechaza listas no disjuntas", () => {
    expect(ok(S, { permitidas: ["juguetes"], quitadas: ["juguetes"], version: 1 })).toBe(false);
    expect(ok(S, { permitidas: ["calzado-ropa", "juguetes"], quitadas: ["entretenimiento", "juguetes"], version: 1 })).toBe(false);
  });
  it.each([
    ["permitidas con categoría fuera de las 6", { permitidas: ["personal"], quitadas: [], version: 1 }],
    ["quitadas con categoría fuera de las 6", { permitidas: [], quitadas: ["Juguetes"], version: 1 }],
    ["permitidas no es lista", { permitidas: "juguetes", quitadas: [], version: 1 }],
    ["quitadas null", { permitidas: [], quitadas: null, version: 1 }],
    ["sin quitadas", { permitidas: [], version: 1 }],
    ["sin permitidas", { quitadas: [], version: 1 }],
    ["sin version", { permitidas: [], quitadas: [] }],
    ["version negativa", { permitidas: [], quitadas: [], version: -1 }],
    ["version decimal", { permitidas: [], quitadas: [], version: 1.5 }],
    ["clave extra efectivas", { permitidas: [], quitadas: [], version: 1, efectivas: [] }],
    ["clave extra clienteId", { permitidas: [], quitadas: [], version: 1, clienteId: "x" }],
    ["null", null],
  ])("rechaza %s", (_c, v) => {
    expect(ok(S, v)).toBe(false);
  });
});

describe("aprenderSchema (R-7, CA-9)", () => {
  const S = "aprenderSchema";
  const t = (termino: string, categoria = "entretenimiento") => ({ termino, categoria });
  it("acepta un término y lo devuelve tal cual", () => {
    const v = { terminos: [t("audifonos")] };
    expect(datos(S, v)).toEqual(v);
  });
  it("acepta hasta 10 términos", () => {
    expect(ok(S, { terminos: Array.from({ length: 10 }, (_, i) => t(`termino${i}`)) })).toBe(true);
  });
  it("rechaza 0 y 11 términos", () => {
    expect(ok(S, { terminos: [] })).toBe(false);
    expect(ok(S, { terminos: Array.from({ length: 11 }, (_, i) => t(`termino${i}`)) })).toBe(false);
  });
  it.each([
    ["término con espacios", t("dos palabras")],
    ["término de 2 letras", t("ab")],
    ["término de 41 letras", t("a".repeat(41))],
    ["término vacío", t("")],
    ["término con etiqueta", t("<script>")],
    ["término número", { termino: 5, categoria: "juguetes" }],
    ["sin categoría (obligatoria)", { termino: "audifonos" }],
    ["categoría null", { termino: "audifonos", categoria: null }],
    ["categoría fuera de las 6", t("audifonos", "personal")],
    ["clave extra en el término", { termino: "audifonos", categoria: "juguetes", palabra: "x" }],
    ["glosa completa en el término", { termino: "audifonos", categoria: "juguetes", glosa: "AUDIFONOS BLUETOOTH" }],
  ])("rechaza %s", (_c, item) => {
    expect(ok(S, { terminos: [item] })).toBe(false);
  });
  it("es estricto y exige terminos", () => {
    expect(ok(S, {})).toBe(false);
    expect(ok(S, { terminos: [t("audifonos")], compraId: "x" })).toBe(false);
    expect(ok(S, { terminos: [t("audifonos")], clienteId: "x" })).toBe(false);
    expect(ok(S, { terminos: "audifonos" })).toBe(false);
    expect(ok(S, null)).toBe(false);
  });
});

describe("editarGlobalSchema (super-admin, D-2)", () => {
  const S = "editarGlobalSchema";
  const v = (o: Record<string, unknown> = {}) => ({ categoria: "calzado-ropa", excepciones: ["seguridad"], activa: true, version: 1, ...o });
  it("acepta el cuerpo completo", () => {
    expect(datos(S, v())).toEqual(v());
    expect(ok(S, v({ excepciones: [], activa: false, version: 9 }))).toBe(true);
  });
  it.each(["categoria", "excepciones", "activa", "version"])("%s es obligatorio", (clave) => {
    const o = v();
    delete (o as Record<string, unknown>)[clave];
    expect(ok(S, o)).toBe(false);
  });
  it.each([
    ["categoría fuera de las 6", { categoria: "otra" }],
    ["6 excepciones", { excepciones: ["a1", "b2", "c3", "d4", "e5", "f6"] }],
    ["excepción de 4 palabras", { excepciones: ["1 2 3 4"] }],
    ["activa como cadena", { activa: "true" }],
    ["version decimal", { version: 1.5 }],
    ["version negativa", { version: -1 }],
    ["palabra (no se puede renombrar)", { palabra: "otra" }],
    ["clave extra", { id: "x" }],
  ])("rechaza %s", (_c, o) => {
    expect(ok(S, v(o))).toBe(false);
  });
  it("rechaza null y arreglos", () => {
    expect(ok(S, null)).toBe(false);
    expect(ok(S, [v()])).toBe(false);
  });
});

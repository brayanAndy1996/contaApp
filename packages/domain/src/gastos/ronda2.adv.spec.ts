// Spec 027 · T18 (ronda adversarial 2, dominio). Caja negra con spec.md (R-3, R-4, R-7, R-10, D-8; CA-4, CA-9, CA-15) y caja blanca
// de `texto/diccionario.ts` (`mismaPalabra`, `formas`, `#agregarDeToken`, `contieneFrase`), `texto/normalizar.ts`,
// `gastos/{contexto,puntaje,terminos}.ts`. Cada prueba que falla es un hallazgo H-027-2-n (ver la tarjeta T18 de tasks.md).
// No repite T15 (`ronda1.adv.spec.ts`) ni las pruebas de T16 (`plural-ambos-sentidos.spec.ts`, `texto/diccionario-plural.spec.ts`).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PROV, SEMILLA_GLOBAL, contextoNeutro } from "../../tests/ayudas/gastos";
import type { PalabraPlana } from "../../tests/ayudas/gastos";
import { DiccionarioGlosas, mismaPalabra } from "../texto/diccionario";
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
const efectivo = (...propias: PalabraPlana[]) => crearDiccionarioEfectivo({ globales: SEMILLA_GLOBAL, desactivadas: [], propias });
const porItem = (d: DiccionarioGlosas, glosas: string[]) =>
  d.coincidenciasPorItem(glosas).map((c) => `${c.item}:${c.categoria}`);

describe("T18 · D-8: la otra forma es la MISMA palabra también en el diccionario efectivo", () => {
  it("H-027-2-1 · (T19: decisión 2026-11-23 = rechazar al agregar, no reemplazar) una BD que ya tiene las dos formas, la propia en la otra forma de una global, no deja que la propia anule la global: gana la menor (D-8)", () => {
    // T18 esperaba que `crearDiccionarioEfectivo` reemplazara la global con su otra forma. El usuario decidió RECHAZAR esa propia al agregarla
    // (409 `palabra_existente`; pruebas en `ronda2.correcciones.int.spec.ts` y `packages/db/src/gastos/ronda2-correcciones.spec.ts`), así que el
    // diccionario efectivo solo la ve en datos anteriores a 0072: ahí rige D-8 («si ya tiene las dos formas, el ítem cuenta una vez y gana la
    // menor en orden de código»): la global «zapatilla» decide y las excepciones de la propia «zapatillas» no rigen. Pasa hoy: queda como regresión.
    const diccionario = efectivo(propia("zapatillas", "entretenimiento", "dielectrica"));
    const r = puntuarGastoPersonal(
      { glosas: ["ZAPATILLA DIELECTRICA"], fechaEmision: "2026-03-11", proveedor: { ...PROV }, esNuevo: false },
      contextoNeutro({ diccionario }),
    );
    expect(r).toMatchObject({ palabra: "zapatilla", categoria: "calzado-ropa" });
    expect(r.senales.map((s) => s.codigo)).toEqual(["S1"]);
  });

  it("H-027-2-2 · con las dos formas guardadas «gana la menor» (D-8): la categoría de la forma perdedora no suma S3", () => {
    // Tienda de ropa (4771) con calzado-ropa permitida en su ajuste. La global «zapatilla» (calzado-ropa) gana por orden de código; la
    // propia «zapatillas» (juguetes, guardada antes de 0071 o antes de que la global existiera) no debería decidir S3.
    const diccionario = efectivo(propia("zapatillas", "juguetes"));
    const r = puntuarGastoPersonal(
      { glosas: ["ZAPATILLAS URBANAS T42"], fechaEmision: "2026-03-11", proveedor: { ...PROV }, esNuevo: false },
      contextoNeutro({ diccionario, ciiuCliente: "4771", categoriasCliente: { permitidas: ["calzado-ropa"], quitadas: [] } }),
    );
    expect(r).toMatchObject({ palabra: "zapatilla", categoria: "calzado-ropa" });
    expect(r.senales.map((s) => s.codigo)).toEqual(["S1"]);
    expect(r.puntaje).toBe(3);
  });

  it("H-027-2-3 · (T19: decisión 2026-11-23 = mantener el plural y agregar frases de excepción) un plural aprendido con sus excepciones no marca el singular que es otra palabra", () => {
    // T18 esperaba que «medias» no marcara «MEDIA PULGADA» sin excepciones. El usuario decidió mantener el plural en ambos sentidos (D-8) y
    // anular los casos conocidos con frases de excepción (se proponen al aprender: `ronda2.correcciones.int.spec.ts`). Aquí queda el mecanismo:
    // con las frases, el singular de la otra palabra no marca y el plural sí.
    const d = efectivo(
      propia("medias", "calzado-ropa", "media pulgada", "media presion"),
      propia("lentes", "cuidado-personal", "lente de camara"),
    );
    expect(porItem(d, ["MEDIAS DEPORTIVAS T-M", "LENTES DE SOL"])).toEqual(["0:calzado-ropa", "1:cuidado-personal"]);
    expect(porItem(d, ["CODO PVC MEDIA PULGADA", "TUBO 1/2 MEDIA PRESION", "LENTE DE CAMARA FOTOGRAFICA"])).toEqual([]);
  });

  it("propiedad (regresión): el índice coincide con un token sin punto exactamente cuando `mismaPalabra(token, palabra)`", () => {
    const letra = fc.constantFrom(..."aeosnrlchzdtjxy");
    const palabra = fc.array(letra, { minLength: 3, maxLength: 7 }).map((l) => l.join(""));
    const sufijo = fc.constantFrom("", "s", "es", "e", "ses", "ces");
    fc.assert(
      fc.property(palabra, palabra, sufijo, fc.boolean(), (p, otra, suf, recortar) => {
        // Token derivado de la palabra (plural, singular o casi) o una palabra cualquiera.
        let token = recortar ? p.slice(0, -suf.length || undefined) : p + suf;
        if (token.length === 0) token = otra;
        const d = DiccionarioGlosas.desde([{ categoria: "juguetes", palabras: [p] }]);
        const indice = d.coincidenciasPorItem([token]).length > 0;
        expect(indice, `${p} / ${token}`).toBe(mismaPalabra(token, p));
        // `buscar` (011) y el índice (027) dicen lo mismo.
        expect(d.buscar([token]) !== null, `${p} / ${token} (buscar)`).toBe(indice);
      }),
      { numRuns: 3000, seed: 20261123 },
    );
  });
});

describe("T18 · excepciones (R-4: «misma normalización» que las palabras)", () => {
  it("H-027-2-4 · una excepción abreviada con punto (≥ 4 letras) anula como anula la abreviatura de una palabra: «ZAPATILLA DE SEGUR.», «BOTA DE JEB.»", () => {
    // La palabra abreviada «zapat.» cuenta (CA-4); la excepción abreviada «segur.» debería anular con la misma regla.
    expect(porItem(efectivo(), ["ZAPAT. DE SEGURIDAD"])).toEqual([]);
    expect(porItem(efectivo(), ["ZAPATILLA DE SEGUR. T-42", "BOTA PUNTA DE ACER."])).toEqual([]);
  });

  it("regresión: excepción solapada con la palabra y en plural («botas de jebe» como excepción de «bota») anula en ambas formas", () => {
    const d = DiccionarioGlosas.desde([{ categoria: "calzado-ropa", palabras: ["bota"], excepciones: ["botas de jebe"] }]);
    expect(d.coincidenciasPorItem(["BOTA DE JEBE", "BOTAS DE JEBES", "BOTAS DE CUERO"]).map((c) => c.item)).toEqual([2]);
  });
});

describe("T18 · Aprender (R-7): unidades y palabras vacías también en su otra forma (D-8)", () => {
  it("H-027-2-5 · no propone la otra forma de una unidad o palabra vacía de la lista («millares», «cientos», «mililitro», «modelos», «marcas», «tipos»)", () => {
    const glosas = ["CIENTOS MILLARES MILILITRO", "MODELOS MARCAS TIPOS"];
    expect(proponerTerminos(glosas, efectivo())).toEqual([]);
  });
});

describe("T18 · Unicode raro dentro de una palabra (R-4: «sin tildes ni mayúsculas»)", () => {
  // Caracteres de formato invisibles (Cf) que llegan pegados en descripciones copiadas: no deberían partir la palabra.
  it.each([
    ["guion suave U+00AD", "ZAPA­TILLAS URBANAS"],
    ["espacio de ancho cero U+200B", "ZAPA​TILLAS URBANAS"],
    ["unión de ancho cero U+200D", "ZAPAT‍ILLA"],
    ["marca izquierda-derecha U+200E", "ZAPATI‎LLA"],
    ["aislamiento bidi U+2066…U+2069", "ZAPA⁦TILLA⁩"],
  ])("H-027-2-6 · %s no impide la coincidencia", (_n, glosa) => {
    expect(porItem(efectivo(), [glosa])).toEqual(["0:calzado-ropa"]);
  });

  it("regresión: ligaduras, ancho completo y ñ con plural en ambos sentidos («ＭＵÑＥＣＡＳ», «ﬁ»)", () => {
    const d = efectivo(propia("ﬁltros", "cuidado-personal"));
    expect(porItem(d, ["ＭＵÑＥＣＡＳ", "FILTRO DE AGUA", "Muñeca."])).toEqual(["0:juguetes", "1:cuidado-personal", "2:juguetes"]);
    expect(tokensDeGlosa("ﬁltros")).toEqual(["filtros"]);
  });
});

describe("T18 · rendimiento (R-10): 2.000 palabras con un prefijo común y abreviaturas que casan con todas", () => {
  const PROPIAS = 2_000;
  const letras = (n: number): string => {
    let r = "";
    let x = n;
    do {
      r = String.fromCharCode(97 + (x % 26)) + r;
      x = Math.floor(x / 26);
    } while (x > 0);
    return r;
  };
  const propias = Array.from({ length: PROPIAS }, (_, i) => propia(`prod${letras(i).padStart(4, "a")}`, "entretenimiento"));
  const d = efectivo(...propias);

  it("H-027-2-7 · una glosa de XML con 2.000 abreviaturas «PROD.» se puntúa en menos de 250 ms", { timeout: 120_000 }, () => {
    const glosa = Array.from({ length: 2_000 }, () => "PROD.").join(" ");
    const a = Date.now();
    const c = d.coincidenciasPorItem([glosa]);
    const ms = Date.now() - a;
    expect(c).toHaveLength(PROPIAS);
    expect(ms).toBeLessThan(250);
  });

  it("H-027-2-7 · 100 compras × 20 ítems con «PROD.» (4 millones de coincidencias, inherentes al resultado) se puntúan en menos de 800 ms", { timeout: 120_000 }, () => {
    // T19: T18 comparaba con ≤ 2× `buscar` (≈ 5 ms, porque `buscar` se detiene en la primera coincidencia); aquí cada ítem casa con las 2.000
    // palabras, así que el costo mínimo es lineal en la salida. El tope absoluto (hoy 2,1 s; lineal ≈ 0,2 s) detecta lo cuadrático sin depender del reloj.
    const compras = Array.from({ length: 100 }, (_, i) =>
      Array.from({ length: 20 }, (_, j) => `PROD. LIMPIEZA ${i}-${j} UND 2.00`),
    );
    const ctx = contextoNeutro({ diccionario: d });
    const correr = (): number => {
      const a = Date.now();
      for (const glosas of compras) puntuarGastoPersonal({ glosas, fechaEmision: null, proveedor: PROV, esNuevo: false }, ctx);
      return Date.now() - a;
    };
    correr();
    const tiempos = [correr(), correr(), correr()].sort((x, y) => x - y);
    expect(tiempos[1]).toBeLessThan(800);
  });
});

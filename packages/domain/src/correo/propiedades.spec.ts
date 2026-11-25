// Spec 028 · T1 (rojo). Propiedades (fast-check) de las plantillas de correo (R-6, CA-7; plan, Contratos: domain):
//  - el HTML nunca contiene etiquetas ni atributos peligrosos (`<img`, `<script`, `<style`, `on…=`, `src`…) ni URL fuera de los enlaces dados;
//  - el texto y el HTML llevan los mismos conteos;
//  - ninguna entrada produce CR/LF, controles ni formato invisible en el asunto;
//  - la entrada no se muta; las funciones son deterministas y no lanzan con ningún texto de usuario.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { armarCorreoAviso, armarCorreoPendientes, armarCorreoResumen, escaparHtml, limpiarLinea } from "../index";
import {
  ENLACES,
  FECHA,
  cliente,
  contar,
  entradaAviso,
  entradaPendientes,
  entradaResumen,
  esperarHtmlSeguro,
  textoVisible,
} from "../../tests/ayudas/correo";

const OPCIONES = { seed: 20261124, numRuns: 300 };

const FRAGMENTOS = [
  "<img src=x onerror=alert(1)>",
  '"><script>alert(1)</script>',
  "<style>@import url(http://evil.test/x.css)</style>",
  "<a href=\"javascript:alert(1)\">x</a>",
  "\r\nBcc: x@y",
  "\n\n",
  "\u0000",
  "\u202e",
  "\u200b",
  "&amp;",
  "&lt;b&gt;",
  "'",
  '"',
  "http://evil.test/pixel.gif",
  "{{x}}",
  "%0d%0aBcc:",
  "Ñandú",
  "😀",
];

const textoHostil: fc.Arbitrary<string> = fc.oneof(
  { arbitrary: fc.string({ unit: "binary", maxLength: 80 }), weight: 3 },
  { arbitrary: fc.array(fc.constantFrom(...FRAGMENTOS), { minLength: 1, maxLength: 6 }).map((a) => a.join("")), weight: 5 },
  { arbitrary: fc.constant("a".repeat(300)), weight: 1 },
  { arbitrary: fc.constant(""), weight: 1 },
);

const TIPOS = ["buzon_critico", "credencial_invalida", "plan_limite"] as const;
const ESTADOS = ["sin_descargar", "abierto", "revisado", null] as const;
const CONTROLES_ASUNTO = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const CONTROLES_CUERPO = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\p{Cf}]/u;

const avisoArb = fc.record({
  razonSocial: fc.option(textoHostil, { nil: null }),
  categoria: fc.option(textoHostil, { nil: null }),
  recurso: textoHostil,
  porcentaje: fc.integer({ min: 1, max: 100 }),
  fecha: fc.date({ min: new Date("2024-01-01T00:00:00Z"), max: new Date("2030-01-01T00:00:00Z"), noInvalidDate: true }),
});
const clienteArb = fc.record({
  razonSocial: textoHostil,
  nuevos: fc.nat(500),
  criticosNuevos: fc.nat(50),
  pendientesAtender: fc.nat(500),
  compras: fc.constantFrom(...ESTADOS),
  ventas: fc.constantFrom(...ESTADOS),
});
const diferidoArb = fc.record({ tipo: fc.constantFrom(...TIPOS), cantidad: fc.integer({ min: 1, max: 999 }) });
const diferidosArb = fc.uniqueArray(diferidoArb, { selector: (d) => d.tipo, maxLength: 3 });

describe("escaparHtml y limpiarLinea · propiedades", () => {
  it("escaparHtml no deja `<`, `>`, `\"` ni `'` y es reversible", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 200 }), (s) => {
        const r = escaparHtml(s);
        expect(r).not.toMatch(/[<>"']/);
        const reversa = r.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
        expect(reversa).toBe(s);
      }),
      OPCIONES,
    );
  });

  it("limpiarLinea: una línea, sin controles ni formato, sin espacios repetidos ni en los extremos, ≤ max y estable al repetirla", () => {
    fc.assert(
      fc.property(textoHostil, fc.integer({ min: 2, max: 80 }), (s, max) => {
        const r = limpiarLinea(s, max);
        expect(r).not.toMatch(CONTROLES_ASUNTO);
        expect(r).not.toMatch(/ {2}/);
        expect(r).toBe(r.trim());
        expect(Array.from(r).length).toBeLessThanOrEqual(max);
        expect(limpiarLinea(r, max)).toBe(r);
      }),
      OPCIONES,
    );
  });
});

describe("plantillas · HTML siempre seguro", () => {
  it("armarCorreoAviso: etiquetas, atributos y enlaces seguros con cualquier texto de usuario", () => {
    fc.assert(
      fc.property(fc.constantFrom(...TIPOS), fc.array(avisoArb, { minLength: 1, maxLength: 25 }), textoHostil, (tipo, avisos, estudio) => {
        const r = armarCorreoAviso(entradaAviso(avisos, { tipo, estudio }));
        esperarHtmlSeguro(r.html);
      }),
      OPCIONES,
    );
  });

  it("armarCorreoResumen: ídem, con clientes y diferidos hostiles", () => {
    fc.assert(
      fc.property(fc.array(clienteArb, { maxLength: 60 }), diferidosArb, textoHostil, (clientes, diferidos, estudio) => {
        const r = armarCorreoResumen(entradaResumen(clientes, { diferidos, estudio }));
        esperarHtmlSeguro(r.html);
      }),
      OPCIONES,
    );
  });

  it("armarCorreoPendientes: ídem", () => {
    fc.assert(
      fc.property(fc.uniqueArray(diferidoArb, { selector: (d) => d.tipo, minLength: 1, maxLength: 3 }), textoHostil, (diferidos, estudio) => {
        const r = armarCorreoPendientes(entradaPendientes(diferidos, { estudio }));
        esperarHtmlSeguro(r.html);
      }),
      OPCIONES,
    );
  });

  it("los enlaces dados son los únicos `href`: con enlaces que traen comillas y `&` el atributo no se rompe", () => {
    const pantalla = 'https://app.contapp.test/ir?a=1&b="2"&c=<x>';
    const baja = "https://app.contapp.test/baja?t=a'b&u=1";
    const r = armarCorreoAviso(entradaAviso([{ razonSocial: "Uno SAC", categoria: "Coactiva", fecha: FECHA }], { enlaces: { pantalla, baja } }));
    esperarHtmlSeguro(r.html, [pantalla, baja]);
    expect(contar(r.html, /href=/g)).toBe(2);
  });
});

describe("plantillas · el asunto y el cuerpo no llevan controles", () => {
  it("ningún asunto tiene CR/LF, controles ni formato invisible; el texto y el HTML, ningún NUL ni formato", () => {
    fc.assert(
      fc.property(fc.array(avisoArb, { minLength: 1, maxLength: 5 }), fc.array(clienteArb, { maxLength: 5 }), diferidosArb, textoHostil, (avisos, clientes, diferidos, estudio) => {
        const salidas = [
          armarCorreoAviso(entradaAviso(avisos, { tipo: "buzon_critico", estudio })),
          armarCorreoAviso(entradaAviso(avisos, { tipo: "credencial_invalida", estudio })),
          armarCorreoAviso(entradaAviso(avisos, { tipo: "plan_limite", estudio })),
          armarCorreoResumen(entradaResumen(clientes, { diferidos, estudio })),
          armarCorreoPendientes(entradaPendientes([{ tipo: "buzon_critico", cantidad: 3 }], { estudio })),
        ];
        for (const s of salidas) {
          expect(s.asunto).not.toMatch(CONTROLES_ASUNTO);
          expect(s.asunto.length).toBeGreaterThan(0);
          expect(s.texto).not.toMatch(CONTROLES_CUERPO);
          expect(s.html).not.toMatch(CONTROLES_CUERPO);
        }
      }),
      OPCIONES,
    );
  });

  it("la parte de texto de usuario del asunto no pasa de 60 puntos de código (razón social y estudio)", () => {
    fc.assert(
      fc.property(textoHostil, (t) => {
        const aviso = armarCorreoAviso(entradaAviso([{ razonSocial: t, categoria: "Coactiva", fecha: FECHA }]));
        expect(Array.from(aviso.asunto).length).toBeLessThanOrEqual(Array.from("Coactiva y avisos críticos del buzón · ").length + 60);
        const resumen = armarCorreoResumen(entradaResumen([cliente("Uno SAC", { nuevos: 1 })], { estudio: t }));
        expect(Array.from(resumen.asunto).length).toBeLessThanOrEqual(Array.from("Resumen diario · ").length + 60 + 40);
      }),
      OPCIONES,
    );
  });
});

describe("plantillas · texto y HTML llevan los mismos conteos", () => {
  /** Enteros del texto (sin URLs ni entidades), ordenados: el HTML y el texto plano deben decir lo mismo. */
  const enteros = (s: string): number[] =>
    [...s.replace(/https?:\/\/\S+/g, " ").replace(/&#?\w+;/g, " ").matchAll(/\d+/g)].map((m) => Number(m[0])).sort((a, b) => a - b);

  it("aviso: mismas líneas y mismo «y N avisos más»", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 60 }), fc.integer({ min: 0, max: 40 }), (n, extraTotal) => {
        const avisos = Array.from({ length: n }, (_, i) => ({ razonSocial: `Cliente ${"abcdefghij"[i % 10]}`, categoria: "CATEGORIA-X", fecha: new Date(FECHA.getTime() + i * 60_000) }));
        const total = n + extraTotal;
        const r = armarCorreoAviso(entradaAviso(avisos, { total }));
        const lineas = Math.min(20, n);
        expect(contar(r.texto, "CATEGORIA-X")).toBe(lineas);
        expect(contar(r.html, "CATEGORIA-X")).toBe(lineas);
        const mas = total > 20 ? total - 20 : 0;
        expect(contar(r.texto, /y \d+ avisos? más/g)).toBe(mas > 0 ? 1 : 0);
        expect(contar(r.html, /y \d+ avisos? más/g)).toBe(mas > 0 ? 1 : 0);
        if (mas > 0) {
          expect(r.texto).toContain(`y ${mas} aviso${mas === 1 ? "" : "s"} más`);
          expect(r.html).toContain(`y ${mas} aviso${mas === 1 ? "" : "s"} más`);
        }
        expect(enteros(r.texto)).toEqual(enteros(textoVisible(r.html)));
      }),
      OPCIONES,
    );
  });

  it("resumen: mismos clientes, mismos números y mismo «y N clientes más»", () => {
    const nombres = ["Alfa", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta"];
    fc.assert(
      fc.property(
        fc.array(fc.record({ nuevos: fc.nat(300), criticosNuevos: fc.nat(40), pendientesAtender: fc.nat(300), compras: fc.constantFrom(...ESTADOS), ventas: fc.constantFrom(...ESTADOS) }), { maxLength: 8 }),
        fc.nat(30),
        diferidosArb,
        (cs, clientesMas, diferidos) => {
          const clientes = cs.map((c, i) => cliente(`Cliente ${nombres[i]}`, c));
          const r = armarCorreoResumen(entradaResumen(clientes, { clientesMas, diferidos }));
          const visible = textoVisible(r.html);
          for (const c of clientes) {
            const nombre = String(c.razonSocial);
            expect(contar(r.texto, nombre)).toBe(1);
            expect(contar(r.html, nombre)).toBe(1);
          }
          expect(contar(r.texto, /y \d+ clientes? más/g)).toBe(clientesMas > 0 ? 1 : 0);
          expect(contar(r.html, /y \d+ clientes? más/g)).toBe(clientesMas > 0 ? 1 : 0);
          expect(contar(r.texto, "Avisos que no te enviamos al momento")).toBe(diferidos.length > 0 ? 1 : 0);
          expect(contar(r.html, "Avisos que no te enviamos al momento")).toBe(diferidos.length > 0 ? 1 : 0);
          expect(enteros(r.texto)).toEqual(enteros(visible));
        },
      ),
      OPCIONES,
    );
  });
});

describe("plantillas · entrada intacta y salida determinista", () => {
  const congelar = <T>(v: T): T => {
    if (v !== null && typeof v === "object" && !Object.isFrozen(v)) {
      Object.freeze(v);
      for (const k of Reflect.ownKeys(v)) congelar((v as Record<PropertyKey, unknown>)[k]);
    }
    return v;
  };

  it("con la entrada congelada a fondo no lanza, no la muta y repetir da lo mismo", () => {
    fc.assert(
      fc.property(fc.array(avisoArb, { minLength: 1, maxLength: 8 }), fc.array(clienteArb, { maxLength: 8 }), diferidosArb, textoHostil, (avisos, clientes, diferidos, estudio) => {
        const a = congelar(entradaAviso(avisos, { estudio }));
        const r = congelar(entradaResumen(clientes, { diferidos, estudio }));
        const p = congelar(entradaPendientes([{ tipo: "plan_limite", cantidad: 2 }], { estudio }));
        const copias = [structuredClone(a), structuredClone(r), structuredClone(p)];
        const primera = [armarCorreoAviso(a), armarCorreoResumen(r), armarCorreoPendientes(p)];
        const segunda = [armarCorreoAviso(a), armarCorreoResumen(r), armarCorreoPendientes(p)];
        expect(segunda).toEqual(primera);
        expect([a, r, p]).toEqual(copias);
      }),
      OPCIONES,
    );
  });

  it("el enlace de baja y el de la app no se alteran en el texto plano", () => {
    const r = armarCorreoResumen(entradaResumen([cliente("Uno SAC", { nuevos: 1 })]));
    expect(r.texto).toContain(ENLACES.baja);
    expect(r.texto).toContain(ENLACES.pantalla);
  });
});

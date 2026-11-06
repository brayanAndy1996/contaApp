// Spec 012 (T3, rojo): texto -> bytes según la codificación del formato (D2, D13). Sin `TextEncoder`
// ni `Buffer`: los bytes esperados son literales. Contrato: `codificar(texto, codificacion)` devuelve
// un `Uint8Array` nuevo y LANZA si un carácter no cabe en la codificación (nunca sustituye por `?`
// ni por U+FFFD). El mensaje del error no incluye el carácter crudo.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { codificar } from "../index";
import { NUM_RUNS, SEMILLA } from "../../tests/ayudas/comprobante";

const bytes = (t: string, c: "ascii" | "latin1" | "utf8") => Array.from(codificar(t, c));

/** Lanza un Error de verdad (no el TypeError de «codificar is not a function» mientras no exista). */
function lanza(f: () => unknown): void {
  let e: unknown;
  try {
    f();
  } catch (x) {
    e = x;
  }
  expect(e).toBeInstanceOf(Error);
  expect((e as Error).message).not.toMatch(/is not a function|not defined/);
}

it("codificar está exportado desde el índice del paquete", () => {
  expect(typeof codificar).toBe("function");
});

describe("codificar · ascii", () => {
  it("codifica U+0000-U+007F byte por byte", () => {
    expect(bytes("Abc 123|", "ascii")).toEqual([0x41, 0x62, 0x63, 0x20, 0x31, 0x32, 0x33, 0x7c]);
    expect(bytes("\u0000\u007f", "ascii")).toEqual([0x00, 0x7f]);
  });

  it("la cadena vacía da cero bytes", () => {
    expect(codificar("", "ascii").length).toBe(0);
  });

  it.each([
    ["ñ", "ñ"],
    ["tilde", "á"],
    ["U+0080", "\u0080"],
    ["euro", "\u20ac"],
    ["emoji", "\u{1F600}"],
  ])("lanza con un carácter fuera de ascii: %s", (_n, texto) => {
    lanza(() => codificar(`a${texto}b`, "ascii"));
  });
});

describe("codificar · latin1", () => {
  it("ñ, Ñ y las vocales con tilde ocupan un byte", () => {
    expect(bytes("ñÑ", "latin1")).toEqual([0xf1, 0xd1]);
    expect(bytes("áéíóú", "latin1")).toEqual([0xe1, 0xe9, 0xed, 0xf3, 0xfa]);
    expect(bytes("¿¡", "latin1")).toEqual([0xbf, 0xa1]);
  });

  it("los bordes U+007F, U+0080, U+00A0 y U+00FF se codifican como su valor", () => {
    expect(bytes("\u007f\u0080\u00a0ÿ", "latin1")).toEqual([0x7f, 0x80, 0xa0, 0xff]);
  });

  it("mezcla ascii y latin1", () => {
    expect(bytes("Año|7", "latin1")).toEqual([0x41, 0xf1, 0x6f, 0x7c, 0x37]);
  });

  it.each([
    ["euro U+20AC", "\u20ac"],
    ["U+0100", "\u0100"],
    ["emoji", "\u{1F600}"],
    ["cherokee U+13AA", "\u13aa"],
    ["marca combinante U+0301 sola", "\u0301"],
    ["sustituto alto suelto", "\ud800"],
    ["sustituto bajo suelto", "\udc00"],
  ])("lanza con un carácter que no cabe en latin1: %s", (_n, texto) => {
    lanza(() => codificar(`a${texto}b`, "latin1"));
  });

  it("un sustituto alto al final o seguido de otro alto también lanza", () => {
    lanza(() => codificar("a\ud83d", "latin1"));
    lanza(() => codificar("\ud83d\ud83d", "latin1"));
    lanza(() => codificar("\ude00\ud83d", "latin1"));
  });

  it("el mensaje del error no contiene el carácter crudo", () => {
    let mensaje = "";
    try {
      codificar("a\u20acb", "latin1");
    } catch (e) {
      mensaje = (e as Error).message;
    }
    expect(mensaje.length).toBeGreaterThan(0);
    expect(mensaje).not.toMatch(/is not a function|not defined/);
    expect(mensaje).not.toContain("\u20ac");
  });

  it("propiedad: toda cadena de U+0000-U+00FF da un byte por carácter con el mismo valor", () => {
    fc.assert(
      fc.property(fc.string({ unit: fc.integer({ min: 0, max: 255 }).map((n) => String.fromCharCode(n)) }), (s) => {
        const esperado = Array.from(s, (c) => c.charCodeAt(0));
        expect(Array.from(codificar(s, "latin1"))).toEqual(esperado);
      }),
      { seed: SEMILLA, numRuns: NUM_RUNS },
    );
  });
});

describe("codificar · utf8", () => {
  it("1 a 4 bytes según el punto de código", () => {
    expect(bytes("A", "utf8")).toEqual([0x41]);
    expect(bytes("ñ", "utf8")).toEqual([0xc3, 0xb1]);
    expect(bytes("\u07ff", "utf8")).toEqual([0xdf, 0xbf]);
    expect(bytes("\u0800", "utf8")).toEqual([0xe0, 0xa0, 0x80]);
    expect(bytes("\u20ac", "utf8")).toEqual([0xe2, 0x82, 0xac]);
    expect(bytes("\uffff", "utf8")).toEqual([0xef, 0xbf, 0xbf]);
    expect(bytes("\u{10000}", "utf8")).toEqual([0xf0, 0x90, 0x80, 0x80]);
    expect(bytes("\u{1F600}", "utf8")).toEqual([0xf0, 0x9f, 0x98, 0x80]);
    expect(bytes("\u{10FFFF}", "utf8")).toEqual([0xf4, 0x8f, 0xbf, 0xbf]);
  });

  it("el NUL se codifica y no corta la cadena", () => {
    expect(bytes("a\u0000b", "utf8")).toEqual([0x61, 0x00, 0x62]);
  });

  it("un sustituto suelto lanza (no se sustituye por U+FFFD)", () => {
    lanza(() => codificar("a\ud800b", "utf8"));
    lanza(() => codificar("a\udc00b", "utf8"));
    lanza(() => codificar("\ud83d", "utf8"));
    lanza(() => codificar("\ude00\ud83d", "utf8"));
  });

  it("propiedad: la concatenación codifica igual que la suma de las partes", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme" }), fc.string({ unit: "grapheme" }), (a, b) => {
        const junto = Array.from(codificar(a + b, "utf8"));
        expect(junto).toEqual([...codificar(a, "utf8"), ...codificar(b, "utf8")]);
      }),
      { seed: SEMILLA, numRuns: NUM_RUNS },
    );
  });
});

describe("codificar · contrato general", () => {
  it("devuelve un Uint8Array puro (no Buffer) y uno nuevo en cada llamada", () => {
    const a = codificar("abc", "latin1");
    const b = codificar("abc", "latin1");
    expect(Object.getPrototypeOf(a)).toBe(Uint8Array.prototype);
    expect(a).not.toBe(b);
    a[0] = 0;
    expect(b[0]).toBe(0x61);
  });

  it("rechaza una codificación desconocida y una entrada que no es string", () => {
    lanza(() => codificar("a", "utf16" as unknown as "utf8"));
    lanza(() => codificar("a", undefined as unknown as "utf8"));
    lanza(() => codificar(123 as unknown as string, "latin1"));
    lanza(() => codificar(null as unknown as string, "latin1"));
  });
});

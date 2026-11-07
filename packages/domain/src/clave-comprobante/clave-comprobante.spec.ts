// Spec 013 (T3, rojo): claveNormalizada(tipo, serie, numero) (D17; plan, Contratos: Dominio).
// Contrato que fija la prueba (T9, `packages/domain/src/clave-comprobante/index.ts`):
//  - devuelve `tipo|SERIE|numero`, con la serie en mayúsculas ASCII (solo a-z, sin locale ni plegado Unicode) y el número
//    sin ceros a la izquierda ("000" → "0", nunca ""). Es la misma normalización de los duplicados de 012. El tipo no se toca.
//  - es la clave única de `venta` por (cliente, periodo): tests/aislamiento/ventas-soporte.ts arma la misma cadena.
//  - pura: no lanza ante cadenas raras y no depende del locale del proceso.
import { describe, expect, it } from "vitest";
import { claveNormalizada } from "./index";

describe("claveNormalizada · forma de la clave", () => {
  it("tipo|SERIE|numero: la boleta 290 es 03|B001|290", () => {
    expect(claveNormalizada("03", "B001", "290")).toBe("03|B001|290");
  });

  it("la serie va en mayúsculas ASCII", () => {
    expect(claveNormalizada("01", "f001", "10")).toBe("01|F001|10");
    expect(claveNormalizada("03", "b0a1", "5")).toBe("03|B0A1|5");
  });

  it("el número pierde los ceros a la izquierda", () => {
    expect(claveNormalizada("03", "B001", "00291")).toBe("03|B001|291");
    expect(claveNormalizada("03", "B001", "0000001")).toBe("03|B001|1");
  });

  it("«000» queda «0», no vacío (H-012-41); «0» y «10» no cambian", () => {
    expect(claveNormalizada("03", "B001", "000")).toBe("03|B001|0");
    expect(claveNormalizada("03", "B001", "0")).toBe("03|B001|0");
    expect(claveNormalizada("03", "B001", "10")).toBe("03|B001|10");
  });

  it("solo quita ceros del principio: los del medio y del final se conservan", () => {
    expect(claveNormalizada("03", "B001", "1000")).toBe("03|B001|1000");
    expect(claveNormalizada("03", "B001", "0100")).toBe("03|B001|100");
  });

  it("un número no numérico solo pierde los ceros iniciales; las letras se conservan tal cual", () => {
    expect(claveNormalizada("03", "B001", "0ABC12")).toBe("03|B001|ABC12");
    expect(claveNormalizada("03", "B001", "abc")).toBe("03|B001|abc");
  });

  it("el tipo no se normaliza (los ceros de «01» son parte del código)", () => {
    expect(claveNormalizada("01", "F001", "1")).toBe("01|F001|1");
    expect(claveNormalizada("07", "F001", "1")).toBe("07|F001|1");
  });
});

describe("claveNormalizada · igualdad de comprobantes", () => {
  it("las variantes de escritura de un mismo comprobante dan la misma clave", () => {
    const k = claveNormalizada("03", "B001", "291");
    expect(claveNormalizada("03", "b001", "291")).toBe(k);
    expect(claveNormalizada("03", "B001", "0291")).toBe(k);
    expect(claveNormalizada("03", "b001", "00291")).toBe(k);
  });

  it("tipos, series o números distintos dan claves distintas (incluida la misma serie en otro tipo)", () => {
    const base = claveNormalizada("03", "B001", "291");
    expect(claveNormalizada("01", "B001", "291")).not.toBe(base);
    expect(claveNormalizada("03", "B002", "291")).not.toBe(base);
    expect(claveNormalizada("03", "B001", "292")).not.toBe(base);
    expect(claveNormalizada("07", "F001", "1")).not.toBe(claveNormalizada("01", "F001", "1"));
  });
});

describe("claveNormalizada · mayúsculas ASCII, sin locale (D17)", () => {
  it("solo a-z cambian: ñ, ß, é y la i sin punto turca se quedan como están", () => {
    expect(claveNormalizada("03", "ñé1", "1")).toBe("03|ñé1|1");
    expect(claveNormalizada("03", "ß001", "1")).toBe("03|ß001|1");
    expect(claveNormalizada("03", "ı001", "1")).toBe("03|ı001|1");
  });

  it("la «i» sube a «I» aunque el proceso tenga un locale turco (no usa toLocaleUpperCase)", () => {
    expect(claveNormalizada("03", "bi01", "1")).toBe("03|BI01|1");
    expect(claveNormalizada("03", "iiii", "1")).toBe("03|IIII|1");
  });

  it("los dígitos ASCII son los únicos ceros que se quitan: «０１» de ancho completo no se toca", () => {
    expect(claveNormalizada("03", "B001", "０１")).toBe("03|B001|０１");
  });
});

describe("claveNormalizada · robustez", () => {
  it("es determinista y no depende de llamadas previas", () => {
    const a = claveNormalizada("03", "B001", "00291");
    for (let i = 0; i < 50; i++) expect(claveNormalizada("03", "B001", "00291")).toBe(a);
  });

  it("devuelve una cadena para entradas largas o con caracteres raros, sin lanzar", () => {
    expect(typeof claveNormalizada("03", "B001", "9".repeat(5000))).toBe("string");
    expect(typeof claveNormalizada("03", "B\u0000 ", "0\n1")).toBe("string");
  });

  it("es idempotente: normalizar el número y la serie ya normalizados no cambia la clave", () => {
    const [tipo, serie, numero] = claveNormalizada("03", "b001", "00291").split("|") as [string, string, string];
    expect(claveNormalizada(tipo, serie, numero)).toBe("03|B001|291");
  });
});

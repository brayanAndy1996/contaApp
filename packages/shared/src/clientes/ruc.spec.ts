import { describe, expect, it } from "vitest";
import { validarRuc } from "./ruc.js";

// Spec 007a (D2, CA-1): validarRuc(ruc: string): boolean, función pura de packages/shared.
// 11 dígitos ASCII, prefijo 10/15/16/17/20, dígito verificador módulo 11 (pesos 5,4,3,2,7,6,5,4,3,2).
// Sin recorte de espacios ni coerción: cualquier cosa que no sea la cadena exacta es inválida.
describe("validarRuc", () => {
  it.each([
    ["10", "10123456781"],
    ["10 (otro)", "10765432109"],
    ["15", "15000000016"],
    ["16", "16000000012"],
    ["17", "17000000019"],
    ["20", "20100070970"],
    ["20 (otro)", "20600000013"],
    ["20 con dígito verificador 0 (11 - resto = 10)", "20000000010"],
    ["20 con dígito verificador 1 (11 - resto = 11 u 1)", "20000000711"],
  ])("acepta un RUC válido de prefijo %s", (_p, ruc) => {
    expect(validarRuc(ruc)).toBe(true);
  });

  it.each([
    ["10", "10123456780"],
    ["20", "20100070971"],
    ["20 (último dígito +1 módulo 10)", "20600000014"],
  ])("rechaza el dígito verificador errado (prefijo %s)", (_p, ruc) => {
    expect(validarRuc(ruc)).toBe(false);
  });

  it.each([
    ["11", "11111111113"],
    ["12", "12111111110"],
    ["30", "30111111118"],
    ["00", "00000000000"],
  ])(
    "rechaza el prefijo %s aunque el dígito verificador sea correcto",
    (_p, ruc) => {
      expect(validarRuc(ruc)).toBe(false);
    },
  );

  it.each([
    ["10 dígitos", "2010007097"],
    ["12 dígitos", "201000709700"],
    ["letras", "2010007097A"],
    ["todo letras", "ABCDEFGHIJK"],
    ["espacio al inicio", " 20100070970"],
    ["espacio al final", "20100070970 "],
    ["espacio interno", "2010007 0970"],
    ["guion", "20-10007097"],
    ["decimal", "2010007097.0"],
    ["dígitos no ASCII (árabe-índicos)", "٢٠١٠٠٠٧٠٩٧٠"],
    ["salto de línea", "20100070970\n"],
    ["cadena vacía", ""],
  ])("rechaza %s", (_c, ruc) => {
    expect(validarRuc(ruc)).toBe(false);
  });

  it.each([
    ["número", 20100070970],
    ["null", null],
    ["undefined", undefined],
    ["objeto", {}],
    ["arreglo", ["20100070970"]],
    ["booleano", true],
    ["String objeto", new String("20100070970")],
  ])("rechaza una entrada que no es string (%s) sin lanzar", (_c, valor) => {
    expect(validarRuc(valor as unknown as string)).toBe(false);
  });
});

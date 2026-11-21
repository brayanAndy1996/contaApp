// Spec 025 (T14a): ramas de `apoyo.ts` sin BD: errores de la capa de datos → HTTP y validación del cursor de candidatas.
import { describe, expect, it } from "vitest";
import { AprendizajeRepoError } from "@contapp/db";
import { AccesoError } from "../acceso/errores.js";
import { ReglasError } from "../reglas/errores.js";
import { aErrorHttp, codificarCursor, decodificarCursor } from "./apoyo.js";

const enBase64Url = (texto: string): string => Buffer.from(texto, "utf8").toString("base64url");

describe("aErrorHttp", () => {
  it("mapea los SQLSTATE de las funciones de 0062 a su respuesta HTTP", () => {
    expect(aErrorHttp(new AprendizajeRepoError("P0002"))).toMatchObject({ name: "AccesoError", response: { codigo: "no_encontrado" } });
    expect(aErrorHttp(new AprendizajeRepoError("55000"))).toBeInstanceOf(AccesoError);
    expect(aErrorHttp(new AprendizajeRepoError("55000"), true)).toBeInstanceOf(ReglasError);
    expect(aErrorHttp(new AprendizajeRepoError("23505"))).toBeInstanceOf(ReglasError);
    expect(aErrorHttp(new AprendizajeRepoError("22023"))).toBeInstanceOf(AccesoError);
  });

  it("un SQLSTATE sin traducción pasa tal cual (el filtro global lo responde 500 sin detalle)", () => {
    const e = new AprendizajeRepoError("40P01");
    expect(aErrorHttp(e)).toBe(e);
    expect(aErrorHttp(new AprendizajeRepoError("XX000"), true)).toBeInstanceOf(AprendizajeRepoError);
  });

  it("un error que no es de la capa de datos pasa tal cual", () => {
    const e = new Error("otro");
    expect(aErrorHttp(e)).toBe(e);
  });
});

describe("cursor de candidatas", () => {
  it("ida y vuelta: lo que se codifica se decodifica igual", () => {
    const p = { docTipo: "6", docNumero: "20100000001" };
    expect(decodificarCursor(codificarCursor(p))).toEqual(p);
  });

  it("rechaza con solicitud_invalida lo que no es base64url", () => {
    expect(() => decodificarCursor("no es base64url!")).toThrowError(AccesoError);
    expect(() => decodificarCursor("")).toThrowError(AccesoError);
  });

  it("rechaza base64url válido cuyo contenido no es JSON", () => {
    expect(() => decodificarCursor(enBase64Url("esto no es json"))).toThrowError(AccesoError);
  });

  it("rechaza JSON de otra forma: no es lista, longitud distinta de 2, elementos no texto, vacíos o de más de 64 caracteres", () => {
    for (const valor of [
      { docTipo: "6", docNumero: "1" },
      "6",
      ["6"],
      ["6", "1", "x"],
      ["6", 1],
      [6, "1"],
      ["", "1"],
      ["6", ""],
      ["6", "a".repeat(65)],
      ["a".repeat(65), "1"],
    ]) {
      expect(() => decodificarCursor(enBase64Url(JSON.stringify(valor)))).toThrowError(AccesoError);
    }
  });

  it("acepta textos de hasta 64 caracteres", () => {
    const p = { docTipo: "a".repeat(64), docNumero: "b".repeat(64) };
    expect(decodificarCursor(codificarCursor(p))).toEqual(p);
  });
});

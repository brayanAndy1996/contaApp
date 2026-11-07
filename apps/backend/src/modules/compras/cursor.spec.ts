// Spec 014 · T15. Cursor opaco del listado (D-13): ida y vuelta, y todo lo que no sea un cursor emitido por el servidor es 400.
import { describe, expect, it } from "vitest";
import { AccesoError } from "../acceso/errores.js";
import { codificarCursor, decodificarCursor } from "./cursor.js";

const POSICION = { fecha: "2026-10-02", serie: "F001", numero: "1040", id: "0198f2a0-7b1c-7d2e-8f3a-123456789abc" };
const crudo = (v: unknown): string => Buffer.from(JSON.stringify(v), "utf8").toString("base64url");

describe("cursor del listado de compras", () => {
  it("ida y vuelta: lo que se codifica se decodifica igual y es base64url", () => {
    const c = codificarCursor(POSICION);
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodificarCursor(c)).toEqual(POSICION);
  });

  it.each([
    ["texto que no es base64url", "no es un cursor!"],
    ["base64 de un JSON vacío", crudo({})],
    ["JSON que no es objeto", crudo([1, 2])],
    ["base64 de texto que no es JSON", Buffer.from("hola", "utf8").toString("base64url")],
    ["clave de más", crudo({ f: "2026-10-02", s: "F001", n: "1", i: POSICION.id, x: 1 })],
    ["fecha que no existe", crudo({ f: "2026-02-31", s: "F001", n: "1", i: POSICION.id })],
    ["id que no es uuid", crudo({ f: "2026-10-02", s: "F001", n: "1", i: "123" })],
    ["serie con caracteres de control", crudo({ f: "2026-10-02", s: "F0\u00001", n: "1", i: POSICION.id })],
    ["más de 1024 caracteres", "a".repeat(1025)],
  ])("rechaza con solicitud_invalida: %s", (_nombre, texto) => {
    expect(() => decodificarCursor(texto)).toThrow(AccesoError);
    try {
      decodificarCursor(texto);
    } catch (e) {
      expect((e as AccesoError).getResponse()).toEqual({ codigo: "solicitud_invalida" });
    }
  });
});

// Spec 017 (T14a): el cursor opaco de notificaciones y auditoría sin BD. Todo lo que no emitió `codificarCursor` es 400.
import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { AccesoError } from "../acceso/errores.js";
import { codificarCursor, decodificarCursor, leerConsulta } from "./cursor.js";

const ID = "0190a000-0000-7000-8000-0000000000a1";
const EN = new Date("2026-10-05T12:30:45.123Z");
const b64 = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v), "utf8").toString("base64url");

function codigo(f: () => unknown): string | undefined {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(AccesoError);
    expect((e as AccesoError).getStatus()).toBe(400);
    return (e as AccesoError).codigo;
  }
  return undefined;
}

describe("cursor de páginas", () => {
  it("ida y vuelta: conserva el instante al milisegundo y pasa el id a minúsculas", () => {
    const c = codificarCursor({ en: EN, id: ID.toUpperCase() });
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    const p = decodificarCursor(c);
    expect(p?.en.toISOString()).toBe("2026-10-05T12:30:45.123Z");
    expect(p?.id).toBe(ID);
  });

  it("sin cursor es la primera página", () => {
    expect(decodificarCursor(undefined)).toBeUndefined();
    expect(leerConsulta(undefined)).toBeUndefined();
    expect(leerConsulta(null)).toBeUndefined();
    expect(leerConsulta({})).toBeUndefined();
  });

  it.each([
    ["vacío", ""],
    ["con caracteres fuera de base64url", "abc+/="],
    ["con espacios", "ab cd"],
    ["más largo que el máximo", "a".repeat(201)],
    ["que no es JSON", b64("no-json{")],
    ["JSON que es un número", b64("42")],
    ["JSON null", b64("null")],
    ["JSON que es un arreglo", b64([1, 2])],
    ["con una clave de más", b64({ e: EN.toISOString(), i: ID, x: 1 })],
    ["con una sola clave", b64({ e: EN.toISOString() })],
    ["con otras claves", b64({ a: EN.toISOString(), b: ID })],
    ["con el instante como número", b64({ e: 1, i: ID })],
    ["con el id como número", b64({ e: EN.toISOString(), i: 7 })],
    ["con instante sin milisegundos", b64({ e: "2026-10-05T12:30:45Z", i: ID })],
    ["con instante con desfase en vez de Z", b64({ e: "2026-10-05T12:30:45.123+00:00", i: ID })],
    ["con instante imposible (mes 13)", b64({ e: "2026-13-05T12:30:45.123Z", i: ID })],
    ["con un id que no es uuid", b64({ e: EN.toISOString(), i: "no-es-uuid" })],
  ])("rechaza un cursor %s con 400 solicitud_invalida", (_n, cursor) => {
    expect(codigo(() => decodificarCursor(cursor))).toBe("solicitud_invalida");
  });

  it("leerConsulta: solo acepta `cursor` como texto; cualquier otra clave o forma es 400", () => {
    const c = codificarCursor({ en: EN, id: ID });
    expect(leerConsulta({ cursor: c })?.id).toBe(ID);
    expect(leerConsulta({ cursor: undefined })).toBeUndefined();
    expect(codigo(() => leerConsulta({ cursor: c, limite: "5" }))).toBe("solicitud_invalida");
    expect(codigo(() => leerConsulta({ usuarioId: ID }))).toBe("solicitud_invalida");
    expect(codigo(() => leerConsulta({ cursor: 5 }))).toBe("solicitud_invalida");
    expect(codigo(() => leerConsulta({ cursor: [c] }))).toBe("solicitud_invalida");
    expect(codigo(() => leerConsulta("cursor"))).toBe("solicitud_invalida");
    expect(codigo(() => leerConsulta([c]))).toBe("solicitud_invalida");
    expect(codigo(() => leerConsulta({ cursor: "###" }))).toBe("solicitud_invalida");
  });
});

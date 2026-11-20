// Spec 024 (T8): el cursor de la bandeja sin BD. Ida y vuelta, huella ligada a filtros y ruta, y todo lo que no emitió `codificarCursor`.
import { describe, expect, it } from "vitest";
import { BuzonError } from "./errores.js";
import { codificarCursor, decodificarCursor, huellaDe } from "./cursor.js";

const ID = "0190a000-0000-7000-8000-0000000000e1";
const FECHA = "2026-11-12T05:00:00.000001Z";
const H = huellaDe("global", { atencion: "pendientes" });
const armar = (o: unknown): string => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
const codigo = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof BuzonError ? e.codigo : "otro";
  }
  return undefined;
};

describe("huellaDe", () => {
  it("son 16 hex, estables, y cambian con cualquier filtro o con la ruta", () => {
    expect(H).toMatch(/^[0-9a-f]{16}$/);
    expect(huellaDe("global", { atencion: "pendientes" })).toBe(H);
    const otros = [
      huellaDe("global", { atencion: "todos" }),
      huellaDe("global", { atencion: "pendientes", categoria: "coactiva" }),
      huellaDe("global", { atencion: "pendientes", leido: "no" }),
      huellaDe("global", { atencion: "pendientes", desde: "2026-11-01" }),
      huellaDe("global", { atencion: "pendientes", hasta: "2026-11-30" }),
      huellaDe("global", { atencion: "pendientes", archivados: true }),
      huellaDe("global", { atencion: "pendientes", responsable: true }),
      huellaDe(`cliente:${ID}`, { atencion: "pendientes" }),
    ];
    expect(new Set([H, ...otros]).size).toBe(otros.length + 1);
  });

  it("la ruta del cliente no distingue mayúsculas del id", () => {
    expect(huellaDe(`cliente:${ID.toUpperCase()}`, { atencion: "todos" })).toBe(huellaDe(`cliente:${ID}`, { atencion: "todos" }));
  });
});

describe("cursor opaco de la bandeja", () => {
  it("ida y vuelta: la fecha conserva los microsegundos y el id queda en minúsculas", () => {
    const c = codificarCursor({ fecha: FECHA, id: ID.toUpperCase() }, H);
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(c.length).toBeLessThanOrEqual(256);
    expect(decodificarCursor(c, H)).toEqual({ fecha: FECHA, id: ID });
  });

  it.each([
    ["vacío", ""],
    ["no es base64url", "%%%"],
    ["texto cualquiera", "no-es-un-cursor"],
    ["más de 256 caracteres", "a".repeat(257)],
    ["relleno de base64", `${Buffer.from("{}").toString("base64")}=`],
    ["JSON vacío", armar({})],
    ["arreglo", armar([1])],
    ["texto JSON", armar("x")],
    ["versión distinta", armar({ v: 2, f: FECHA, i: ID, h: H })],
    ["sin huella", armar({ v: 1, f: FECHA, i: ID })],
    ["huella de otros filtros", armar({ v: 1, f: FECHA, i: ID, h: huellaDe("global", { atencion: "todos" }) })],
    ["huella que no es hex", armar({ v: 1, f: FECHA, i: ID, h: "zzzzzzzzzzzzzzzz" })],
    ["clave de más", armar({ v: 1, f: FECHA, i: ID, h: H, extra: 1 })],
    ["id que no es uuid", armar({ v: 1, f: FECHA, i: "x", h: H })],
    ["fecha sin microsegundos", armar({ v: 1, f: "2026-11-12T05:00:00Z", i: ID, h: H })],
    ["fecha con zona", armar({ v: 1, f: "2026-11-12T05:00:00.000001-05:00", i: ID, h: H })],
    ["fecha inexistente", armar({ v: 1, f: "2026-02-31T05:00:00.000001Z", i: ID, h: H })],
    ["año cero", armar({ v: 1, f: "0000-11-12T05:00:00.000001Z", i: ID, h: H })],
    ["tipos que no son texto", armar({ v: 1, f: 1, i: 2, h: 3 })],
  ])("rechaza «%s» con cursor_invalido", (_nombre, cursor) => {
    expect(codigo(() => decodificarCursor(cursor, H))).toBe("cursor_invalido");
  });
});

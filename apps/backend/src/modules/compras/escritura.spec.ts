// Spec 014 (T16): `aErrorHttp`, `aSolicitudInvalida` y `exigir` sin BD: cada incumplimiento de regla de `packages/db` sale con
// su estado y su cuerpo, y lo que no es de compras pasa tal cual (el filtro global lo responde 500 sin detalle).
import "reflect-metadata";
import { ComprasReglaError } from "@contapp/db";
import { MontoFueraDeRangoError } from "@contapp/domain";
import { describe, expect, it } from "vitest";
import { AccesoError } from "../acceso/errores.js";
import { ComprasError } from "./errores.js";
import { aErrorHttp, aSolicitudInvalida, exigir } from "./escritura.js";

const ID = "0190a000-0000-7000-8000-0000000000a1";
const cuerpo = (e: unknown): unknown => (e as ComprasError).cuerpo;

describe("aErrorHttp", () => {
  it("no_encontrada y solicitud_invalida salen como los códigos de acceso (404 y 400)", () => {
    const a = aErrorHttp(new ComprasReglaError("no_encontrada"));
    expect(a).toBeInstanceOf(AccesoError);
    expect((a as AccesoError).getStatus()).toBe(404);
    const b = aErrorHttp(new ComprasReglaError("solicitud_invalida"));
    expect((b as AccesoError).getStatus()).toBe(400);
  });

  it("version_obsoleta lleva la versión vigente; fila_cambiada, los ids; duplicado, el id de la existente", () => {
    expect(cuerpo(aErrorHttp(new ComprasReglaError("version_obsoleta", { versionVigente: 3 })))).toEqual({ codigo: "version_obsoleta", versionVigente: 3 });
    expect(cuerpo(aErrorHttp(new ComprasReglaError("fila_cambiada", { ids: [ID] })))).toEqual({ codigo: "fila_cambiada", ids: [ID] });
    expect(cuerpo(aErrorHttp(new ComprasReglaError("duplicado", { ids: [ID, "otro"] })))).toEqual({ codigo: "duplicado", id: ID });
  });

  it("requiere_dato lleva el dato pedido, y sin él solo el código", () => {
    expect(cuerpo(aErrorHttp(new ComprasReglaError("requiere_dato"), "gravado"))).toEqual({ codigo: "requiere_dato", dato: "gravado" });
    expect(cuerpo(aErrorHttp(new ComprasReglaError("requiere_dato")))).toEqual({ codigo: "requiere_dato" });
  });

  it("los códigos sin datos salen con su estado", () => {
    const e = aErrorHttp(new ComprasReglaError("nada_que_deshacer")) as ComprasError;
    expect(e.getStatus()).toBe(409);
    expect(e.cuerpo).toEqual({ codigo: "nada_que_deshacer" });
  });

  it("lo que no es de compras, o un código desconocido, pasa sin traducir", () => {
    const raro = new Error("boom");
    expect(aErrorHttp(raro)).toBe(raro);
    const desconocido = new ComprasReglaError("inventado");
    expect(aErrorHttp(desconocido)).toBe(desconocido);
  });
});

describe("aSolicitudInvalida", () => {
  it("un error de dinero es 400; cualquier otro pasa tal cual", () => {
    const d = aSolicitudInvalida(new MontoFueraDeRangoError());
    expect(d).toBeInstanceOf(AccesoError);
    expect((d as AccesoError).getStatus()).toBe(400);
    const otro = new TypeError("x");
    expect(aSolicitudInvalida(otro)).toBe(otro);
  });
});

describe("exigir", () => {
  it("devuelve el valor y, si es null, el 404 de siempre", () => {
    expect(exigir({ a: 1 })).toEqual({ a: 1 });
    expect(() => exigir(null)).toThrow(AccesoError);
  });
});

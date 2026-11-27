import { describe, expect, it } from "vitest";
import { capturarSync, esperarError } from "../pruebas/ayudas-http.js";
import { indicesPorEncabezado, normalizarEncabezado } from "./encabezados.js";

// Contrato de `txt/encabezados.ts` (plan 041, Decisiones «Encabezado»; spec CA-5, P-1):
//  - `normalizarEncabezado(texto)`: quita BOM, NFC, recorta, colapsa espacios (incluidos los de ancho cero no; solo
//    espacios y tabuladores) en uno y pasa a minúsculas. `"Razón  Social"` y `"RAZÓN SOCIAL"` dan lo mismo.
//  - `indicesPorEncabezado(encabezado, requeridas)`: `encabezado` son las celdas crudas de la primera línea;
//    `requeridas` son nombres (se normalizan). Devuelve un mapa nombre NORMALIZADO → índice de columna solo de las
//    requeridas. Requerida ausente o que aparece 2+ veces (ya normalizada) -> `ErrorPortalSire("encabezado")`.
//    Columnas extra y repetidas que NO son requeridas se ignoran.

describe("normalizarEncabezado", () => {
  it("quita BOM, recorta, colapsa espacios y baja a minúsculas", () => {
    expect(normalizarEncabezado("﻿Ruc")).toBe("ruc");
    expect(normalizarEncabezado("  Apellidos Nombres/ Razón  Social ")).toBe("apellidos nombres/ razón social");
    expect(normalizarEncabezado("Nro   CP\tmodificado")).toBe("nro cp modificado");
    expect(normalizarEncabezado("TOTAL CP")).toBe("total cp");
  });

  it("NFC: tilde compuesta y descompuesta son iguales", () => {
    const nfd = "Fecha de emisión";
    expect(nfd).not.toBe("Fecha de emisión");
    expect(normalizarEncabezado(nfd)).toBe(normalizarEncabezado("Fecha de emisión"));
  });

  it("no quita las tildes ni la puntuación (Razon ≠ Razón; el punto cuenta)", () => {
    expect(normalizarEncabezado("Razon Social")).not.toBe(normalizarEncabezado("Razón Social"));
    expect(normalizarEncabezado("Est. Comp.")).not.toBe(normalizarEncabezado("Est. Comp"));
  });
});

describe("indicesPorEncabezado", () => {
  const CAB = ["RUC", "Periodo", "Total CP", "Moneda", "CLU1"];

  it("devuelve el índice de cada requerida bajo su nombre normalizado", () => {
    const m = indicesPorEncabezado(CAB, ["RUC", "Total CP", "Moneda"]);
    expect(m.get("ruc")).toBe(0);
    expect(m.get("total cp")).toBe(2);
    expect(m.get("moneda")).toBe(3);
    expect(m.has("clu1")).toBe(false);
  });

  it("no depende del orden, de las mayúsculas, del BOM ni de los espacios", () => {
    const m = indicesPorEncabezado(["﻿moneda ", "TOTAL   CP", "ruc"], ["RUC", "Total CP", "Moneda"]);
    expect([m.get("ruc"), m.get("total cp"), m.get("moneda")]).toEqual([2, 1, 0]);
  });

  it("ignora columnas extra (conocidas o no)", () => {
    const m = indicesPorEncabezado([...CAB, "Columna Nueva Prueba"], ["RUC", "Total CP"]);
    expect(m.get("ruc")).toBe(0);
    expect(m.get("total cp")).toBe(2);
  });

  it("requerida ausente -> ErrorPortalSire encabezado", () => {
    const e = capturarSync(() => indicesPorEncabezado(["RUC", "Periodo"], ["RUC", "Total CP"]));
    esperarError(e, "ErrorPortalSire", "encabezado");
  });

  it("requerida duplicada (aun con otra forma de escribirla) -> ErrorPortalSire encabezado", () => {
    const e = capturarSync(() => indicesPorEncabezado(["RUC", "Total CP", "total  cp"], ["RUC", "Total CP"]));
    esperarError(e, "ErrorPortalSire", "encabezado");
  });

  it("una columna repetida que NO se requiere no estorba", () => {
    const m = indicesPorEncabezado(["RUC", "Total CP", "CLU1", "CLU1"], ["RUC", "Total CP"]);
    expect(m.get("total cp")).toBe(1);
  });

  it("encabezado vacío -> ErrorPortalSire encabezado", () => {
    esperarError(capturarSync(() => indicesPorEncabezado([], ["RUC"])), "ErrorPortalSire", "encabezado");
  });
});

// Spec 014 (T16): la respuesta de marcar revisado y reabrir, y el permiso de reabrir, sin BD.
import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { AccesoError } from "../acceso/errores.js";
import { PeriodoComprasService, aRespuestaEstado } from "./periodo.service.js";

describe("aRespuestaEstado", () => {
  it("`por` y `en` van a null mientras nadie haya marcado el periodo", () => {
    expect(aRespuestaEstado({ estado: "abierto", marcadoPor: null, marcadoEn: null })).toEqual({ estado: "abierto", por: null, en: null });
  });

  it("`en` sale como fecha ISO", () => {
    const en = new Date("2026-11-07T12:00:00.000Z");
    expect(aRespuestaEstado({ estado: "revisado", marcadoPor: "u", marcadoEn: en })).toEqual({ estado: "revisado", por: "u", en: "2026-11-07T12:00:00.000Z" });
  });
});

describe("PeriodoComprasService.reabrir", () => {
  it("sin sire.aprobar_generar es 403 antes de abrir ninguna transacción", () => {
    const servicio = new PeriodoComprasService({ withTenant: () => Promise.reject(new Error("no debe abrir la BD")) });
    expect(() => servicio.reabrir({} as never, { tipo: "global" }, new Set(["sire.clasificar"]), "c", "202610")).toThrow(AccesoError);
  });
});

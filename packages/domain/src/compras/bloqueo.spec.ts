// Spec 014 · T1 (rojo). Bloqueo de escrituras por estado del periodo y permiso (D-9, DU-4; CA-12).
// Contrato fijado por estas pruebas (plan 014, Contratos: Dominio), en packages/domain/src/compras/bloqueo.ts,
// exportado por compras/index.ts:
//   type EstadoPeriodo = "abierto" | "revisado" | "generado"
//   type ResultadoEscritura = { ok: true } | { ok: false; codigo: "periodo_revisado" | "periodo_generado" }
//   puedeEscribir(estado: EstadoPeriodo, permisos: readonly string[]): ResultadoEscritura
// `permisos` son los del usuario (nombres de shared: "sire.clasificar", "sire.aprobar_generar"...). La función
// solo decide por el ESTADO: que el usuario tenga el permiso base de la acción (sire.clasificar,
// sire.descargar) lo comprueba el guard de permisos, no esta función.
//   abierto  → ok.
//   revisado → ok solo con "sire.aprobar_generar"; si no, { ok: false, codigo: "periodo_revisado" } (403).
//   generado → nadie: { ok: false, codigo: "periodo_generado" } (409), tampoco con "sire.aprobar_generar";
//              hay que reabrir antes.
// Pura: no muta `permisos`; un estado desconocido lanza (no deja pasar en silencio).
import { describe, expect, it } from "vitest";
import { puedeEscribir } from "./index";

const CLASIFICAR = ["sire.clasificar"];
const APROBAR = ["sire.clasificar", "sire.aprobar_generar"];

describe("puedeEscribir: matriz estado × permiso (D-9)", () => {
  it.each([
    ["abierto", CLASIFICAR, { ok: true }],
    ["abierto", APROBAR, { ok: true }],
    ["revisado", CLASIFICAR, { ok: false, codigo: "periodo_revisado" }],
    ["revisado", APROBAR, { ok: true }],
    ["generado", CLASIFICAR, { ok: false, codigo: "periodo_generado" }],
    ["generado", APROBAR, { ok: false, codigo: "periodo_generado" }],
  ] as const)("%s con %j", (estado, permisos, esperado) => {
    expect(puedeEscribir(estado, permisos)).toEqual(esperado);
  });

  it("revisado con solo sire.descargar tampoco pasa", () => {
    expect(puedeEscribir("revisado", ["sire.descargar"])).toEqual({ ok: false, codigo: "periodo_revisado" });
  });

  it("revisado con sire.aprobar_generar solo (sin clasificar) pasa: el estado es lo único que decide", () => {
    expect(puedeEscribir("revisado", ["sire.aprobar_generar"])).toEqual({ ok: true });
  });

  it("un permiso parecido no sirve (distingue mayúsculas y prefijos)", () => {
    expect(puedeEscribir("revisado", ["SIRE.APROBAR_GENERAR"])).toEqual({ ok: false, codigo: "periodo_revisado" });
    expect(puedeEscribir("revisado", ["sire.aprobar_generar.x"])).toEqual({ ok: false, codigo: "periodo_revisado" });
    expect(puedeEscribir("revisado", ["sire.aprobar"])).toEqual({ ok: false, codigo: "periodo_revisado" });
  });

  it("revisado sin ningún permiso: periodo_revisado", () => {
    expect(puedeEscribir("revisado", [])).toEqual({ ok: false, codigo: "periodo_revisado" });
  });

  it("generado sin ningún permiso: periodo_generado", () => {
    expect(puedeEscribir("generado", [])).toEqual({ ok: false, codigo: "periodo_generado" });
  });
});

describe("puedeEscribir: robustez", () => {
  it("no muta la lista de permisos", () => {
    const permisos = Object.freeze([...APROBAR]);
    expect(() => puedeEscribir("revisado", permisos)).not.toThrow();
    expect(permisos).toEqual(APROBAR);
  });

  it.each(["", "cerrado", "ABIERTO", "Abierto", null, undefined, 1])("un estado desconocido (%j) lanza", (estado) => {
    expect(() => puedeEscribir(estado as never, APROBAR)).toThrow();
  });

  it("es determinista", () => {
    expect(puedeEscribir("revisado", CLASIFICAR)).toEqual(puedeEscribir("revisado", CLASIFICAR));
  });
});

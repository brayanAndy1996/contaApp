import { describe, expect, it } from "vitest";
import { estadoPeriodoRespuestaSchema, reabrirPeriodoSchema } from "../compras/index.js";
import { resumenVentasSchema } from "./index.js";

// Spec 012b · T2 (rojo). Estado del periodo de ventas y resumen de ventas (P-1, D5, D12; CA-10, CA-15).
// Contrato fijado por estas pruebas:
//  - `POST …/ventas/estado/revisar` y `…/reabrir {estadoVisto}` reutilizan las formas de 014
//    (estadoPeriodoRespuestaSchema, reabrirPeriodoSchema), que `shared` ya exporta; el índice de shared sigue
//    exportándolas una sola vez (sin choque de nombres con 012b).
//  - resumenVentasSchema (packages/shared/src/ventas/exclusion.ts): la forma de `ResumenVentasDto` (013) más
//    `estado` ("abierto"|"revisado"|"generado") y `excluidas` (entero >= 0, cantidad; las excluidas NO suman).
const monto = (v = "0.00") => ({ baseGravada: v, igv: v, exonerada: v, inafecta: v, isc: v, icbper: v, otros: v, total: v });

const resumen = (extra: Record<string, unknown> = {}) => ({
  porTipo: [{ tipo: "01", cantidad: 2, ...monto("100.00") }],
  total: { cantidad: 2, ...monto("100.00") },
  sinConvertir: [{ clave: "F001-5", moneda: "USD" }],
  avisos: ["usd_sin_tipo_cambio"],
  estado: "abierto",
  excluidas: 0,
  ...extra,
});

const ok = (v: unknown) => resumenVentasSchema.safeParse(v).success;

describe("resumenVentasSchema", () => {
  it("acepta el resumen con estado y excluidas y devuelve los mismos datos", () => {
    const r = resumenVentasSchema.safeParse(resumen({ estado: "generado", excluidas: 2 }));
    expect(r.success).toBe(true);
    expect(r.data).toEqual(resumen({ estado: "generado", excluidas: 2 }));
  });

  it("estado es abierto, revisado o generado", () => {
    for (const estado of ["abierto", "revisado", "generado"]) expect(ok(resumen({ estado })), estado).toBe(true);
    for (const estado of ["cerrado", "", null, undefined, 1]) expect(ok(resumen({ estado })), String(estado)).toBe(false);
  });

  it("excluidas es un entero >= 0 y es obligatorio", () => {
    expect(ok(resumen({ excluidas: 0 }))).toBe(true);
    expect(ok(resumen({ excluidas: 7 }))).toBe(true);
    for (const v of [-1, 1.5, "2", null, undefined]) expect(ok(resumen({ excluidas: v })), String(v)).toBe(false);
  });

  it("los montos solo son cadenas decimales (nunca number)", () => {
    expect(ok(resumen({ total: { cantidad: 2, ...monto("100.00"), total: 100 } }))).toBe(false);
    expect(ok(resumen({ porTipo: [{ tipo: "01", cantidad: 1, ...monto("0.005") }] }))).toBe(false);
  });

  it("conserva sinConvertir y avisos de 013", () => {
    expect(ok(resumen({ sinConvertir: [], avisos: [] }))).toBe(true);
    expect(ok(resumen({ avisos: ["otro"] }))).toBe(false);
  });
});

describe("estado del periodo de ventas reutiliza las formas de 014", () => {
  it("estadoPeriodoRespuestaSchema acepta {estado, por, en}", () => {
    expect(estadoPeriodoRespuestaSchema.safeParse({ estado: "revisado", por: null, autor: null, en: null }).success).toBe(true);
    expect(estadoPeriodoRespuestaSchema.safeParse({ estado: "generado", por: null, autor: null, en: null }).success).toBe(true);
  });

  it("reabrirPeriodoSchema admite revisado y generado, no abierto", () => {
    expect(reabrirPeriodoSchema.safeParse({ estadoVisto: "generado" }).success).toBe(true);
    expect(reabrirPeriodoSchema.safeParse({ estadoVisto: "revisado" }).success).toBe(true);
    expect(reabrirPeriodoSchema.safeParse({ estadoVisto: "abierto" }).success).toBe(false);
  });
});

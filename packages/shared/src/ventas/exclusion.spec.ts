import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { exclusionVentaSchema, excluirVentaSchema, restaurarVentaSchema } from "./index.js";

// Spec 012b · T2 (rojo). Excluir y restaurar ventas (D12, P-8; CA-15, CA-16; plan, Contratos: HTTP).
// Contrato fijado por estas pruebas (packages/shared/src/ventas/exclusion.ts, exportado por ventas/index.ts):
//  - excluirVentaSchema: ESTRICTO, {motivo}. El motivo se recorta (trim) y debe quedar de 1 a 200 caracteres;
//    "   " (solo espacios) se rechaza. Cualquier clave extra (ventaId, tenantId, usuarioId, versionBase…) se RECHAZA.
//    El largo se mide en caracteres tras recortar: 200 pasan, 201 no.
//  - restaurarVentaSchema: ESTRICTO, cuerpo vacío `{}`; cualquier clave se rechaza.
//  - exclusionVentaSchema: lo que lleva `VentaDto.exclusion`: `{motivo, por: uuid, en: ISO}` o null.
//    (T8 también agrega `exclusion: ExclusionVenta | null` a la interfaz `VentaDto`.)
describe("excluirVentaSchema", () => {
  it("acepta un motivo válido y lo devuelve recortado", () => {
    const r = excluirVentaSchema.safeParse({ motivo: "  Llegó descuadrada del SIRE  " });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ motivo: "Llegó descuadrada del SIRE" });
  });

  it("acepta 1 y 200 caracteres y rechaza 0 y 201", () => {
    expect(excluirVentaSchema.safeParse({ motivo: "x" }).success).toBe(true);
    expect(excluirVentaSchema.safeParse({ motivo: "x".repeat(200) }).success).toBe(true);
    expect(excluirVentaSchema.safeParse({ motivo: "" }).success).toBe(false);
    expect(excluirVentaSchema.safeParse({ motivo: "x".repeat(201) }).success).toBe(false);
  });

  it("recorta antes de medir: 200 caracteres con espacios alrededor pasan; solo espacios no", () => {
    const r = excluirVentaSchema.safeParse({ motivo: ` ${"x".repeat(200)} ` });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ motivo: "x".repeat(200) });
    for (const m of ["   ", "\t\n", " "]) expect(excluirVentaSchema.safeParse({ motivo: m }).success, JSON.stringify(m)).toBe(false);
    expect(excluirVentaSchema.safeParse({ motivo: ` ${"x".repeat(201)} ` }).success).toBe(false);
  });

  it("el motivo es obligatorio y de tipo cadena", () => {
    for (const body of [{}, { motivo: null }, { motivo: 5 }, { motivo: ["x"] }, { motivo: undefined }]) {
      expect(excluirVentaSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it("rechaza (no descarta) las claves extra", () => {
    for (const extra of [{ ventaId: randomUUID() }, { tenantId: "t" }, { usuarioId: "u" }, { versionBase: 1 }, { restaurar: true }]) {
      expect(excluirVentaSchema.safeParse({ motivo: "ok", ...extra }).success, Object.keys(extra)[0]).toBe(false);
    }
  });

  it("rechaza un cuerpo que no es objeto", () => {
    for (const v of [null, undefined, "x", 1, []]) expect(excluirVentaSchema.safeParse(v).success).toBe(false);
  });
});

describe("restaurarVentaSchema", () => {
  it("acepta el objeto vacío", () => {
    const r = restaurarVentaSchema.safeParse({});
    expect(r.success).toBe(true);
    expect(r.data).toEqual({});
  });

  it("rechaza cualquier clave (estricto)", () => {
    for (const body of [{ motivo: "x" }, { versionBase: 1 }, { ventaId: randomUUID() }, { a: 1 }]) {
      expect(restaurarVentaSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it("rechaza un cuerpo que no es objeto", () => {
    for (const v of [null, "x", 1, []]) expect(restaurarVentaSchema.safeParse(v).success).toBe(false);
  });
});

describe("exclusionVentaSchema (VentaDto.exclusion)", () => {
  const ok = (v: unknown) => exclusionVentaSchema.safeParse(v).success;

  it("acepta null (venta no excluida)", () => {
    const r = exclusionVentaSchema.safeParse(null);
    expect(r.success).toBe(true);
    expect(r.data).toBeNull();
  });

  it("acepta {motivo, por, en} y devuelve los mismos datos", () => {
    const e = { motivo: "Llegó descuadrada", por: randomUUID(), en: "2026-11-10T10:00:00.000Z" };
    const r = exclusionVentaSchema.safeParse(e);
    expect(r.success).toBe(true);
    expect(r.data).toEqual(e);
  });

  it("exige los tres campos con su tipo", () => {
    const e = { motivo: "m", por: randomUUID(), en: "2026-11-10T10:00:00.000Z" };
    for (const k of Object.keys(e)) {
      const resto = Object.fromEntries(Object.entries(e).filter(([c]) => c !== k));
      expect(ok(resto), `sin ${k}`).toBe(false);
    }
    expect(ok({ ...e, por: "no-uuid" })).toBe(false);
    expect(ok({ ...e, en: "ayer" })).toBe(false);
    expect(ok({ ...e, motivo: 5 })).toBe(false);
    expect(ok(undefined)).toBe(false);
  });
});

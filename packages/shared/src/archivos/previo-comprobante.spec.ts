import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { avisoPrevioSchema, errorPrevioSchema } from "./respuestas.js";

// Spec 012b, T23a (P-3): cada error y aviso del previo dice de qué comprobante es (`SERIE-NUMERO`, o null si no hay fila).

const error = (extra: Record<string, unknown> = {}) => ({
  filaId: randomUUID(),
  codigo: "CUADRE",
  campo: "total",
  destino: null,
  explicacion: "La suma de componentes no es igual al total",
  diferencia: "32.00",
  excluible: true,
  ...extra,
});
const aviso = (extra: Record<string, unknown> = {}) => ({
  filaId: randomUUID(),
  codigo: "R-NEW",
  explicacion: "Proveedor nuevo",
  ...extra,
});

describe("comprobante en errores y avisos del previo", () => {
  it("conserva el SERIE-NUMERO, o null cuando el error no es de una fila", () => {
    expect(errorPrevioSchema.parse(error({ comprobante: "F003-20" })).comprobante).toBe("F003-20");
    expect(errorPrevioSchema.parse(error({ filaId: null, comprobante: null })).comprobante).toBeNull();
    expect(avisoPrevioSchema.parse(aviso({ comprobante: "F001-2056" })).comprobante).toBe("F001-2056");
    expect(avisoPrevioSchema.parse(aviso({ filaId: null, comprobante: null })).comprobante).toBeNull();
  });

  it("rechaza un comprobante vacío o que no es texto", () => {
    for (const comprobante of ["", 12, {}, ["F001-1"]]) {
      expect(errorPrevioSchema.safeParse(error({ comprobante })).success, String(comprobante)).toBe(false);
      expect(avisoPrevioSchema.safeParse(aviso({ comprobante })).success, String(comprobante)).toBe(false);
    }
  });

  it("una respuesta sin el campo (servidor anterior) sigue siendo válida", () => {
    expect(errorPrevioSchema.safeParse(error()).success).toBe(true);
    expect(avisoPrevioSchema.safeParse(aviso()).success).toBe(true);
  });
});

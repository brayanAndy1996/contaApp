// Spec 013 (T3, rojo): la API pública de `@contapp/domain` incluye las funciones nuevas (plan: Archivos, `src/index.ts`).
// La lista exacta de exportaciones está en `src/ronda2b.adv.spec.ts` (R2b-1), ampliada en T3 con estos seis valores.
import { describe, expect, it } from "vitest";
import * as dominio from "../index";

describe("exportaciones de 013", () => {
  it("claveNormalizada, analizarCorrelatividad, resumirVentas, planificarComplemento, LAYOUT_VENTAS_PROVISIONAL y validarFilaVenta salen del índice", () => {
    for (const f of ["claveNormalizada", "analizarCorrelatividad", "resumirVentas", "planificarComplemento", "validarFilaVenta"]) {
      expect(typeof (dominio as Record<string, unknown>)[f], f).toBe("function");
    }
    expect(typeof (dominio as Record<string, unknown>).LAYOUT_VENTAS_PROVISIONAL).toBe("object");
  });

  it("el índice no filtra Decimal ni helpers internos de las carpetas nuevas", () => {
    const nombres = Object.keys(dominio);
    expect(nombres).not.toContain("Decimal");
    expect(nombres).not.toContain("D");
    expect(nombres.filter((n) => /^(esEntero|compararNumero|normalizarNumero)/.test(n))).toEqual([]);
  });
});

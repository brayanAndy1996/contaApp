import { describe, expect, it } from "vitest";
import { limiteEfectivoRucs } from "./limites.js";

// D6 y D10: limite efectivo de RUCs = max_rucs + min(rucs_extra_contratados, max_rucs_extra).
// Funcion pura con enteros; bajar el tope del plan nunca da mas cupo del permitido.
describe("limiteEfectivoRucs (D6, D10)", () => {
  it.each([
    // [maxRucs, maxRucsExtra, contratados, esperado, motivo]
    [30, 6, 0, 30, "sin adicionales"],
    [30, 6, 2, 32, "contratados menor que el tope"],
    [30, 6, 4, 34, "contratados menor que el tope (Independiente)"],
    [30, 6, 6, 36, "contratados igual al tope"],
    [30, 6, 10, 36, "contratados mayor que el tope: se recorta al tope"],
    [100, 20, 0, 100, "Estudio sin adicionales"],
    [100, 20, 20, 120, "Estudio con el tope completo"],
    [100, 20, 25, 120, "Estudio con contratados sobre el tope"],
    [300, 60, 61, 360, "Estudio Pro, un adicional sobre el tope"],
    [600, 120, 120, 720, "Corporativo con el tope completo"],
    [5, 0, 0, 5, "Prueba sin adicionales"],
    [5, 0, 3, 5, "tope 0: los contratados no suman nada (el super-admin bajo el tope)"],
    [1, 0, 1000, 1, "contratados enorme con tope 0"],
  ] as const)(
    "limiteEfectivoRucs(%i, %i, %i) = %i (%s)",
    (maxRucs, maxRucsExtra, contratados, esperado, motivo) => {
      expect(
        limiteEfectivoRucs(maxRucs, maxRucsExtra, contratados),
        motivo,
      ).toBe(esperado);
    },
  );

  it("bajar el tope del plan nunca da mas cupo que antes (D10)", () => {
    const antes = limiteEfectivoRucs(100, 20, 15);
    const despues = limiteEfectivoRucs(100, 10, 15);
    expect(antes).toBe(115);
    expect(despues).toBe(110);
    expect(despues).toBeLessThanOrEqual(antes);
  });

  it("es pura: mismos argumentos, mismo resultado, y devuelve un entero", () => {
    const a = limiteEfectivoRucs(30, 6, 4);
    const b = limiteEfectivoRucs(30, 6, 4);
    expect(a).toBe(b);
    expect(Number.isInteger(a)).toBe(true);
  });
});

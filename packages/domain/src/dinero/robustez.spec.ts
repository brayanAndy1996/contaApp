import { describe, expect, it } from "vitest";
import {
  DineroError,
  Factor,
  FactorInvalidoError,
  Money,
  MontoExacto,
  MontoInvalidoError,
  MovimientoInvalidoError,
  TASA_IGV_18,
  TOLERANCIA_CUADRE,
  igvCuadra,
  redondearSunat,
  verificarCuadre,
} from "../index";

// Pruebas unitarias del backend (T8): entradas de tipo incorrecto en tiempo de
// ejecución y conversiones de MontoExacto. Complementan las de T5 sin modificarlas.

const pen = (s: string): Money => Money.desde(s, "PEN");

describe("MontoExacto · conversión a string", () => {
  it("toString y `${x}` dan el valor exacto sin exponente ni -0", () => {
    const x = pen("2.25").por(Factor.desde("0.18"));
    expect(x.toString()).toBe("0.405");
    expect(`${x}`).toBe("0.405");
    expect(MontoExacto.desde("-0.0000000000", "PEN").toString()).toBe("0");
  });
  it("+x y x + y lanzan (no se opera como número)", () => {
    const x = MontoExacto.desde("1.5", "PEN");
    expect(() => +(x as unknown as string)).toThrow(TypeError);
    expect(
      () => (x as unknown as number) + (x as unknown as number),
    ).toThrow(TypeError);
  });
});

describe("tipos incorrectos en tiempo de ejecución", () => {
  it("por con algo que no es Factor ni TipoCambio lanza FactorInvalidoError", () => {
    expect(() => pen("1.00").por("0.18" as unknown as Factor)).toThrow(
      FactorInvalidoError,
    );
    expect(() =>
      MontoExacto.desde("1", "PEN").entre({} as unknown as Factor),
    ).toThrow(FactorInvalidoError);
  });
  it("redondearSunat con algo que no es MontoExacto lanza MontoInvalidoError", () => {
    expect(() =>
      redondearSunat(pen("1.00") as unknown as MontoExacto),
    ).toThrow(MontoInvalidoError);
  });
  it("una tolerancia que no es Tolerancia lanza MontoInvalidoError", () => {
    expect(() =>
      igvCuadra(
        pen("100.00"),
        pen("18.00"),
        TASA_IGV_18,
        "0.01" as unknown as typeof TOLERANCIA_CUADRE,
      ),
    ).toThrow(MontoInvalidoError);
  });
  it("una moneda desconocida lanza MontoInvalidoError", () => {
    expect(() => Money.desde("1.00", "EUR" as unknown as "PEN")).toThrow(
      MontoInvalidoError,
    );
    expect(() => Money.cero("EUR" as unknown as "PEN")).toThrow(
      MontoInvalidoError,
    );
  });
  it("Money.suma con un elemento que no es Money lanza DineroError", () => {
    const c = {
      moneda: "PEN" as const,
      total: pen("1.00"),
      componentes: () => [{ moneda: "PEN" } as unknown as Money],
    };
    expect(() => verificarCuadre(c, TOLERANCIA_CUADRE)).toThrow(DineroError);
  });
});

describe("MovimientoInvalidoError", () => {
  it("es DineroError con código propio y mensaje fijo", () => {
    const e = new MovimientoInvalidoError();
    expect(e).toBeInstanceOf(DineroError);
    expect(e.codigo).toBe("MOVIMIENTO_INVALIDO");
    expect(e.name).toBe("MovimientoInvalidoError");
    expect(e.message.length).toBeGreaterThan(0);
  });
});

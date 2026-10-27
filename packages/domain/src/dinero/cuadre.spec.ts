import { beforeEach, describe, expect, it } from "vitest";
import {
  DineroError,
  Money,
  MonedaDistintaError,
  TOLERANCIA_CUADRE,
  TOLERANCIA_IGV,
  Tolerancia,
  verificarCuadre,
} from "../index";
import type { Cuadrable, Moneda } from "../index";

// verificarCuadre genérico (D2: total − Σ componentes; tolerancia 0.00 para el cuadre
// del TXT) sobre un Cuadrable de prueba. CA-10 y D4 (ventas lo reutiliza en 013).

const pen = (s: string): Money => Money.desde(s, "PEN");

function cuadrable(
  total: string,
  componentes: string[],
  moneda: Moneda = "PEN",
): Cuadrable {
  return {
    moneda,
    total: Money.desde(total, moneda),
    componentes: () => componentes.map((c) => Money.desde(c, moneda)),
  };
}

/** Si la API pública aún no exporta algo, TODA prueba falla por esa razón (rojo explícito). */
beforeEach(() => {
  const funciones: Record<string, unknown> = {
    DineroError,
    Money,
    MonedaDistintaError,
    Tolerancia,
    verificarCuadre,
  };
  for (const [nombre, valor] of Object.entries(funciones)) {
    expect(valor, `@contapp/domain debe exportar ${nombre}`).toBeTypeOf(
      "function",
    );
  }
  const valores: Record<string, unknown> = {
    TOLERANCIA_CUADRE,
    TOLERANCIA_IGV,
  };
  for (const [nombre, valor] of Object.entries(valores)) {
    expect(valor, `@contapp/domain debe exportar ${nombre}`).toBeDefined();
  }
});

describe("CA-10 · verificarCuadre (signo: total − suma)", () => {
  it("total 100.01 con componentes que suman 100.00: cuadra=false, diferencia '0.01'", () => {
    const r = verificarCuadre(
      cuadrable("100.01", ["60.00", "40.00"]),
      Tolerancia.desde("0.00"),
    );
    expect(r.cuadra).toBe(false);
    expect(r.diferencia.toString()).toBe("0.01");
    expect(r.sumaComponentes.toString()).toBe("100.00");
    expect(r.total.toString()).toBe("100.01");
  });
  it("total 99.99 con componentes que suman 100.00: cuadra=false, diferencia '-0.01'", () => {
    const r = verificarCuadre(
      cuadrable("99.99", ["60.00", "40.00"]),
      TOLERANCIA_CUADRE,
    );
    expect(r.cuadra).toBe(false);
    expect(r.diferencia.toString()).toBe("-0.01");
  });
  it("con diferencia 0.00 cuadra", () => {
    const r = verificarCuadre(
      cuadrable("100.00", ["60.00", "40.00"]),
      TOLERANCIA_CUADRE,
    );
    expect(r.cuadra).toBe(true);
    expect(r.diferencia.toString()).toBe("0.00");
    expect(r.diferencia.esCero()).toBe(true);
  });
  it("el resultado son Money (sumaComponentes, total, diferencia)", () => {
    const r = verificarCuadre(cuadrable("10.00", ["10.00"]), TOLERANCIA_CUADRE);
    expect(r.sumaComponentes).toBeInstanceOf(Money);
    expect(r.total).toBeInstanceOf(Money);
    expect(r.diferencia).toBeInstanceOf(Money);
  });
});

describe("tolerancia del cuadre", () => {
  it("TOLERANCIA_CUADRE (0.00) rechaza 0.01; TOLERANCIA_IGV (0.01) lo acepta (inclusivo)", () => {
    const c = cuadrable("100.01", ["100.00"]);
    expect(verificarCuadre(c, TOLERANCIA_CUADRE).cuadra).toBe(false);
    expect(verificarCuadre(c, TOLERANCIA_IGV).cuadra).toBe(true);
  });
  it("la tolerancia es simétrica y la diferencia conserva su signo", () => {
    const c = cuadrable("99.99", ["100.00"]);
    const r = verificarCuadre(c, Tolerancia.desde("0.01"));
    expect(r.cuadra).toBe(true);
    expect(r.diferencia.toString()).toBe("-0.01");
  });
  it("0.02 de diferencia no cuadra con tolerancia 0.01 pero sí con 0.02", () => {
    const c = cuadrable("100.02", ["100.00"]);
    expect(verificarCuadre(c, Tolerancia.desde("0.01")).cuadra).toBe(false);
    expect(verificarCuadre(c, Tolerancia.desde("0.02")).cuadra).toBe(true);
    expect(
      verificarCuadre(cuadrable("99.98", ["100.00"]), Tolerancia.desde("0.01"))
        .cuadra,
    ).toBe(false);
  });
});

describe("verificarCuadre genérico", () => {
  it("suma componentes con signos mezclados (nota de crédito)", () => {
    const r = verificarCuadre(
      cuadrable("-118.00", ["-100.00", "-18.00"]),
      TOLERANCIA_CUADRE,
    );
    expect(r.cuadra).toBe(true);
    expect(r.sumaComponentes.toString()).toBe("-118.00");
    const r2 = verificarCuadre(
      cuadrable("0.00", ["50.00", "-50.00"]),
      TOLERANCIA_CUADRE,
    );
    expect(r2.cuadra).toBe(true);
    expect(r2.sumaComponentes.toString()).toBe("0.00");
  });
  it("componentes vacíos suman 0.00: total 0.00 cuadra, total 0.01 no", () => {
    expect(
      verificarCuadre(cuadrable("0.00", []), TOLERANCIA_CUADRE).cuadra,
    ).toBe(true);
    const r = verificarCuadre(cuadrable("0.01", []), TOLERANCIA_CUADRE);
    expect(r.cuadra).toBe(false);
    expect(r.diferencia.toString()).toBe("0.01");
  });
  it("una lista larga no acumula error (0.10 × 100 = 10.00)", () => {
    const r = verificarCuadre(
      cuadrable(
        "10.00",
        Array.from({ length: 100 }, () => "0.10"),
      ),
      TOLERANCIA_CUADRE,
    );
    expect(r.cuadra).toBe(true);
    expect(r.diferencia.toString()).toBe("0.00");
  });
  it("llama a componentes() de forma que el orden no altera el resultado", () => {
    const a = verificarCuadre(
      cuadrable("0.30", ["0.10", "0.20"]),
      TOLERANCIA_CUADRE,
    );
    const b = verificarCuadre(
      cuadrable("0.30", ["0.20", "0.10"]),
      TOLERANCIA_CUADRE,
    );
    expect(a.sumaComponentes.toString()).toBe(b.sumaComponentes.toString());
    expect(a.cuadra && b.cuadra).toBe(true);
  });
  it("en USD funciona igual y no mezcla monedas", () => {
    const r = verificarCuadre(
      cuadrable("0.18", ["0.15", "0.03"], "USD"),
      TOLERANCIA_CUADRE,
    );
    expect(r.cuadra).toBe(true);
    expect(r.total.moneda).toBe("USD");
    expect(r.diferencia.moneda).toBe("USD");
  });
  it("un componente de otra moneda lanza MonedaDistintaError", () => {
    const c: Cuadrable = {
      moneda: "PEN",
      total: pen("10.00"),
      componentes: () => [pen("5.00"), Money.desde("5.00", "USD")],
    };
    expect(() => verificarCuadre(c, TOLERANCIA_CUADRE)).toThrow(
      MonedaDistintaError,
    );
  });
  it("un total de otra moneda que la del Cuadrable lanza MonedaDistintaError", () => {
    const c: Cuadrable = {
      moneda: "PEN",
      total: Money.desde("10.00", "USD"),
      componentes: () => [pen("10.00")],
    };
    expect(() => verificarCuadre(c, TOLERANCIA_CUADRE)).toThrow(DineroError);
  });
  it("detecta la diferencia en los extremos del rango sin desbordar el resultado", () => {
    const r = verificarCuadre(
      cuadrable("999999999999.99", ["999999999999.98"]),
      TOLERANCIA_CUADRE,
    );
    expect(r.cuadra).toBe(false);
    expect(r.diferencia.toString()).toBe("0.01");
  });
});

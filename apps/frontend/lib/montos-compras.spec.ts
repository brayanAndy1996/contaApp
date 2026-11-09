import { describe, expect, it } from "vitest";
import {
  MOTIVOS_MONTO,
  conMiles,
  destinoDe,
  iguales,
  sumar,
  validarMonto,
} from "./montos-compras";

const bases = (biDg: string, biDgng: string, biDng: string) => ({
  biDg,
  biDgng,
  biDng,
});

describe("sumar e iguales (CA-5)", () => {
  it("suma exacta, sin error de coma flotante: 0.1 + 0.2 + 0.005 = 0.305", () => {
    expect(sumar(["0.1", "0.2", "0.005"])).toBe("0.305");
    expect(sumar(["0.1", "0.2"])).toBe("0.30");
    // Con `number` esto da 0.30000000000000004.
    expect(iguales(sumar(["0.1", "0.2"]), "0.3")).toBe(true);
  });

  it("suma 5.000 montos de 14 dígitos y los negativos sin perder un céntimo", () => {
    const muchos = Array.from({ length: 5000 }, () => "999999999999.99");
    expect(sumar(muchos)).toBe("4999999999999950.00");
    expect(sumar(["100.00", "-100.00"])).toBe("0.00");
    expect(sumar([])).toBe("0.00");
    expect(sumar(["-0.00"])).toBe("0.00");
  });

  it("una cadena que no es decimal lanza y no da un total a medias", () => {
    expect(() => sumar(["1.00", "abc"])).toThrow(RangeError);
    expect(() => sumar(["1e3"])).toThrow(RangeError);
    expect(() => sumar([""])).toThrow(RangeError);
  });

  it("iguales compara por valor y rechaza lo que no es decimal", () => {
    expect(iguales("1.5", "1.50")).toBe(true);
    expect(iguales("-0.00", "0.00")).toBe(true);
    expect(iguales("1.50", "1.51")).toBe(false);
    expect(iguales("x", "x")).toBe(false);
  });
});

describe("conMiles", () => {
  it("separa miles con coma y deja 2 decimales: 1,234.56", () => {
    expect(conMiles("1234.56")).toBe("1,234.56");
    expect(conMiles("1234567.8")).toBe("1,234,567.80");
    expect(conMiles("0")).toBe("0.00");
    expect(conMiles("999.99")).toBe("999.99");
  });

  it("negativo con «-» y el cero negativo se muestra sin signo", () => {
    expect(conMiles("-1234567.89")).toBe("-1,234,567.89");
    expect(conMiles("-0.00")).toBe("0.00");
  });

  it("un texto que no es monto vuelve tal cual (React lo escapa)", () => {
    expect(conMiles("<b>1</b>")).toBe("<b>1</b>");
    expect(conMiles("")).toBe("");
  });
});

describe("validarMonto", () => {
  it("acepta montos con 0 a 2 decimales y devuelve la forma canónica", () => {
    expect(validarMonto("12")).toEqual({ ok: true, valor: "12.00" });
    expect(validarMonto(" 12.5 ")).toEqual({ ok: true, valor: "12.50" });
    expect(validarMonto("007.30")).toEqual({ ok: true, valor: "7.30" });
    expect(validarMonto("-45.10")).toEqual({ ok: true, valor: "-45.10" });
    expect(validarMonto("-0")).toEqual({ ok: true, valor: "0.00" });
    expect(validarMonto("999999999999.99")).toEqual({
      ok: true,
      valor: "999999999999.99",
    });
  });

  it("rechaza más de 2 decimales con su motivo, sin redondear", () => {
    expect(validarMonto("10.005")).toEqual({
      ok: false,
      motivo: MOTIVOS_MONTO.decimales,
    });
    expect(validarMonto("0.001")).toEqual({
      ok: false,
      motivo: MOTIVOS_MONTO.decimales,
    });
  });

  it("rechaza texto no numérico y vacío", () => {
    expect(validarMonto("abc")).toEqual({ ok: false, motivo: MOTIVOS_MONTO.formato });
    expect(validarMonto("1,234.50")).toEqual({ ok: false, motivo: MOTIVOS_MONTO.formato });
    expect(validarMonto("1e3")).toEqual({ ok: false, motivo: MOTIVOS_MONTO.formato });
    expect(validarMonto(".5")).toEqual({ ok: false, motivo: MOTIVOS_MONTO.formato });
    expect(validarMonto("   ")).toEqual({ ok: false, motivo: MOTIVOS_MONTO.vacio });
  });

  it("rechaza un signo mal puesto y más de 12 enteros", () => {
    for (const malo of ["+5", "5-", "--5", "1-2"]) {
      expect(validarMonto(malo)).toEqual({ ok: false, motivo: MOTIVOS_MONTO.signo });
    }
    expect(validarMonto("1000000000000.00")).toEqual({
      ok: false,
      motivo: MOTIVOS_MONTO.enteros,
    });
  });
});

describe("destinoDe (P-5)", () => {
  it("una sola base distinta de cero da su destino", () => {
    expect(destinoDe(bases("100.00", "0.00", "0.00"))).toBe("DG");
    expect(destinoDe(bases("0.00", "50.00", "0.00"))).toBe("DGNG");
    expect(destinoDe(bases("0.00", "0.00", "-20.00"))).toBe("DNG");
  });

  it("más de una base es Mixta y ninguna es Sin base", () => {
    expect(destinoDe(bases("100.00", "0.00", "10.00"))).toBe("Mixta");
    expect(destinoDe(bases("1.00", "2.00", "3.00"))).toBe("Mixta");
    expect(destinoDe(bases("0.00", "0.00", "0.00"))).toBe("Sin base");
    expect(destinoDe(bases("-0.00", "0", "0.0"))).toBe("Sin base");
  });
});

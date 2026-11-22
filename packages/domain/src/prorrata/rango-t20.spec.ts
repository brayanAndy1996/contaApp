// Spec 026 · T20 (backend): bordes de H-026-2-3 que las pruebas de T19 no fijan en el dominio. Un mes cuyas columnas o total no caben
// en NUMERIC(14,2) (sumas SIRE sin tope, conversión USD, tres columnas de 12 dígitos) no lanza: sus montos salen en el tope con su
// signo, el mes queda `fueraDeRango` y el coeficiente es `montos_fuera_de_rango`.
import { describe, expect, it } from "vitest";
import { Acumulado } from "../dinero/acumulado";
import { MontoInvalidoError } from "../dinero/index";
import { calcularProrrata, resolverMes, type MesProrrata, type TotalesSire } from "../index";

const Z = "0.00";
const TOPE = "999999999999.99";
const VENTANA = ["202511", "202512", "202601", "202602", "202603", "202604", "202605", "202606", "202607", "202608", "202609", "202610"];
const montos = (m: MesProrrata) => [m.gravadas, m.exportaciones, m.noGravadas, m.total].map(String);
const sire = (pen: Partial<TotalesSire["pen"]>, usd: TotalesSire["usd"] = []): TotalesSire => ({
  pen: { baseGravada: Z, exonerada: Z, inafecta: Z, ...pen },
  usd,
});
const mesSire = (s: TotalesSire) => resolverMes({ periodo: "202601", declaraciones: [], manual: null, sire: s });
const ventanaCon = (mes202601: MesProrrata): MesProrrata[] =>
  VENTANA.map((periodo) =>
    periodo === "202601"
      ? mes202601
      : resolverMes({ periodo, declaraciones: [], manual: { gravadas: "1000.00", exportaciones: Z, noGravadas: Z }, sire: null }),
  );

describe("H-026-2-3 · mes SIRE cuya suma no cabe en NUMERIC(14,2)", () => {
  it("dos exoneradas de 600.000.000.000,00 (suma SQL de 1,2 billones): tope, fuera de rango y coeficiente «montos_fuera_de_rango»", () => {
    const m = mesSire(sire({ exonerada: "1200000000000.00" }));
    expect(m.origen).toBe("sire");
    expect(m.fueraDeRango).toBe(true);
    expect(montos(m)).toEqual([Z, Z, TOPE, TOPE]);
    expect(calcularProrrata(ventanaCon(m))).toEqual({ estado: "no_determinable", motivo: "montos_fuera_de_rango" });
  });

  it("notas de crédito que pasan del tope en negativo: el tope negativo", () => {
    const m = mesSire(sire({ baseGravada: "-1500000000000.50" }));
    expect(m.fueraDeRango).toBe(true);
    expect(montos(m)).toEqual([`-${TOPE}`, Z, Z, `-${TOPE}`]);
  });

  it("una fila USD cuya conversión no cabe: fuera de rango (sin lanzar)", () => {
    const m = mesSire(sire({}, [{ baseGravada: "900000000000.00", exonerada: Z, inafecta: Z, tipoCambio: "3.750" }]));
    expect(m.fueraDeRango).toBe(true);
    expect(String(m.gravadas)).toBe(TOPE);
  });

  it("control: una suma SQL de 12 dígitos que cabe sale tal cual y el mes no está fuera de rango", () => {
    const m = mesSire(sire({ baseGravada: "999999999999.98" }, [{ baseGravada: "0.01", exonerada: Z, inafecta: Z, tipoCambio: "1.000" }]));
    expect(m.fueraDeRango).toBe(false);
    expect(montos(m)).toEqual([TOPE, Z, Z, TOPE]);
  });

  it.each([["exponente", "1.2e12"], ["3 decimales", "1.234"], ["número", 5], ["31 enteros", "1".repeat(31)], ["espacios", " 1.00"]])(
    "una suma SQL mal formada (%s) lanza MontoInvalidoError",
    (_n, valor) => {
      expect(() => mesSire(sire({ inafecta: valor as string }))).toThrow(MontoInvalidoError);
    },
  );
});

describe("H-026-2-4 · el total de un mes no cabe aunque cada columna sí", () => {
  it("manual con las tres columnas en 999.999.999.999,99: el total sale en el tope y el coeficiente es «montos_fuera_de_rango»", () => {
    const m = resolverMes({ periodo: "202601", declaraciones: [], manual: { gravadas: TOPE, exportaciones: TOPE, noGravadas: TOPE }, sire: null });
    expect(m.fueraDeRango).toBe(true);
    expect(montos(m)).toEqual([TOPE, TOPE, TOPE, TOPE]);
    expect(calcularProrrata(ventanaCon(m))).toEqual({ estado: "no_determinable", motivo: "montos_fuera_de_rango" });
  });

  it("control: un mes normal no está fuera de rango", () => {
    expect(resolverMes({ periodo: "202601", declaraciones: [], manual: { gravadas: "1.00", exportaciones: Z, noGravadas: Z }, sire: null }).fueraDeRango).toBe(false);
  });
});

describe("Acumulado (interno de dinero/)", () => {
  it("no se construye fuera de su módulo y queda congelado", () => {
    const Ctor = Acumulado as unknown as new (c: symbol, d: unknown) => Acumulado;
    expect(() => new Ctor(Symbol("Acumulado"), 1)).toThrow(TypeError);
    expect(Object.isFrozen(Acumulado.cero())).toBe(true);
  });
});
